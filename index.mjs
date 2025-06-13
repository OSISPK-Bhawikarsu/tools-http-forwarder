
import url from "url";
import path from "path";
import http from "http";
import https from "https";
import cluster from "cluster";
import os from "os";
import consoleStamp from "console-stamp";
import httpProxy from "http-proxy";
import trumpet from "@gofunky/trumpet";
import zlib from "zlib";
import { isUint8Array } from "util/types";
consoleStamp(console, { format: ":date(mm/dd HH:MM:ss.l) :label" });

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT;
const proxyHttpAgent = new http.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000
});
const proxyHttpsAgent = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000
});

function regexReplace(regex, string, replacer) {
	let lastIndex = 0;
	let result = "";
	let matcher;
	while((matcher = regex.exec(string)) != null) {
		const replace = replacer(matcher);
		result += string.slice(lastIndex, matcher.index);
		result += replace;
		lastIndex = matcher.index + matcher[0].length;
	}
	result += string.slice(lastIndex);
	return result;
}
class HTTPError extends Error {
	constructor(code, message) {
		super(message);
		this.httpCode = code;
		this.stack = "";
	}
}
class ZlibTransformStream extends TransformStream {
	constructor(stream, flushDelay, flushBytes) {
		let dataCallback;
		let errorCallback;
		let drainCallback;
		let flushTimeoutHandle;
		let bytesWritten;
		let lastFlushBytesWritten;
		super({
			start: controller => {
				stream.on("data", dataCallback = chunk => {
					// Currently, cancelled streams are not handled in node.js
					// https://github.com/nodejs/node/issues/49971
					try { controller.enqueue(chunk); } catch(e) {}
				});
				stream.on("error", errorCallback = e => {
					stream.close();
					stream.off("data", dataCallback);
					stream.off("error", errorCallback);
					if(drainCallback != null)
						stream.off("drain", drainCallback);
					controller.error(e);
				});
				bytesWritten = 0;
				lastFlushBytesWritten = 0;
			},
			flush: controller => {
				return new Promise(resolve => {
					if(flushTimeoutHandle != null)
						clearTimeout(flushTimeoutHandle);
					// Set to zero instead of null to disable future flushing
					flushTimeoutHandle = 0;
					lastFlushBytesWritten = bytesWritten;
					stream.flush(() => {
						stream.close();
						stream.off("data", dataCallback);
						stream.off("error", errorCallback);
						if(drainCallback != null)
							stream.off("drain", drainCallback);
						controller.terminate();
						resolve();
					});
				});
			},
			transform: chunk => {
				const needWait = !stream.write(chunk);
				bytesWritten += chunk.length;
				if(flushDelay <= 0 || bytesWritten - lastFlushBytesWritten >= flushBytes) {
					lastFlushBytesWritten = bytesWritten;
					stream.flush();
					if(flushTimeoutHandle != null)
						clearTimeout(flushTimeoutHandle);
					flushTimeoutHandle = null;
					if(!needWait) return;
					return new Promise(r => stream.once("drain", drainCallback = r));
				}
				// Don't reschedule flush timeout, since we are accumulating chunks
				if(flushTimeoutHandle != null || !isFinite(flushDelay)) {
					if(!needWait) return;
					return new Promise(r => stream.once("drain", drainCallback = r));
				}
				const timeoutHandle = flushTimeoutHandle = setTimeout(() => {
					lastFlushBytesWritten = bytesWritten;
					stream.flush(() => {
						if(flushTimeoutHandle != timeoutHandle) return;
						flushTimeoutHandle = null;
					});
				}, flushDelay);
				if(!needWait) return;
				return new Promise(r => stream.once("drain", drainCallback = r));
			}
		});
	}
}
class TrumpetTransformStream extends TransformStream {
	constructor(stream) {
		let dataCallback;
		let errorCallback;
		let drainCallback;
		let endCallback;
		super({
			start: controller => {
				stream.on("data", dataCallback = chunk => {
					// Currently, cancelled streams are not handled in node.js
					// https://github.com/nodejs/node/issues/49971
					try { controller.enqueue(chunk); } catch(e) {}
				});
				stream.on("error", errorCallback = e => {
					stream.end();
					stream.off("data", dataCallback);
					stream.off("error", errorCallback);
					if(drainCallback != null)
						stream.off("drain", drainCallback);
					if(endCallback != null)
						stream.off("end", endCallback);
					controller.error(e);
				});
			},
			flush: controller => {
				return new Promise(resolve => {
					stream.once("end", endCallback = () => {
						stream.off("data", dataCallback);
						stream.off("error", errorCallback);
						if(drainCallback != null)
							stream.off("drain", drainCallback);
						if(endCallback != null)
							stream.off("end", endCallback);
						controller.terminate();
						resolve();
					});
					stream.end();
				});
			},
			transform: chunk => {
				const needWait = !stream.write(chunk);
				if(!needWait) return;
				return new Promise(r => stream.once("drain", drainCallback = r));
			}
		});
	}
}

function tapNodeStream(stream, tapper) {
	let originalWrite;
	let originalEnd;
	let readableCancelled;
	let readableQueue;
	let readableUnlock;
	let readableBackpressure;
	let cleaned;
	let cleanup;
	const readable = tapper(new ReadableStream({
		type: "bytes",
		start: controller => {
			originalWrite = stream.write.bind(stream);
			originalEnd = stream.end.bind(stream);
			readableCancelled = false;
			readableQueue = [];
			readableUnlock = null;
			readableBackpressure = () => readableQueue.reduce((p, [b]) => p + (b != null ? b.length : 0), 0) <= 2048;
			cleaned = false;
			cleanup = (error) => {
				if(cleaned) return;
				cleaned = true;
				readableCancelled = true;
				if(readableUnlock != null) {
					readableUnlock();
					readableUnlock = null;
				}
				if(error == null) controller.close();
				else controller.error(error);
			};
			stream.addListener("close", () => cleanup());
			stream.addListener("error", e => cleanup(e));
			stream.write = (data, encoding, callback) => {
				readableQueue.push([data, encoding, callback]);
				if(readableUnlock != null) {
					readableUnlock();
					readableUnlock = null;
				}
				return readableBackpressure();
			};
			stream.end = (data, encoding, callback) => {
				if(typeof data == "function") {
					callback = data;
					data = null;
				}
				if(data != null || callback != null)
					readableQueue.push([data, encoding, callback]);
				readableQueue.push([null, null, () => cleanup()]);
				if(readableUnlock != null) {
					readableUnlock();
					readableUnlock = null;
				}
			};
		},
		pull: controller => {
			if(readableCancelled)
				return;
			const entry = readableQueue.shift();
			if(entry != null) {
				const [data, encoding, callback] = entry;
				if(readableBackpressure())
					stream.emit("drain");
				if(data != null)
					controller.enqueue(isUint8Array(data) ? data : Buffer.from(data, encoding));
				if(callback != null)
					process.nextTick(callback);
				return;
			}
			return (async () => {
				let entry;
				while(!readableCancelled && (entry = readableQueue.shift()) == null)
					await new Promise(r => readableUnlock = r);
				if(entry == null) return;
				const [data, encoding, callback] = entry;
				if(readableBackpressure())
					stream.emit("drain");
				if(data != null)
					controller.enqueue(isUint8Array(data) ? data : Buffer.from(data, encoding));
				if(callback != null)
					process.nextTick(callback);
			})();
		},
		cancel: error => {
			if(error != null)
				stream.emit("error", error);
			cleanup(error);
		}
	}));
	readable.pipeTo(new WritableStream({
		write: chunk => new Promise(r => originalWrite(chunk, null, r)),
		close: () => new Promise(r => originalEnd(r)),
		abort: error => error != null && stream.emit("error", error)
	}));
}

function trumpetStreamModifier(stream, modifiersStack) {
	let headerInspected = false;
	let isHtml;
	let contentEncoding;
	const inspectHeader = () => {
		if(headerInspected) return;
		headerInspected = true;
		const headers = stream.getHeaders();
		isHtml = (headers["content-type"] || "").toLowerCase().includes("text/html");
		contentEncoding = (headers["content-encoding"] || "").toLowerCase();
	};
	let streamInitiated = false;
	const initStream = () => {
		if(streamInitiated) return;
		streamInitiated = true;
		tapNodeStream(stream, readable => {
			if(contentEncoding == "br")
				readable = readable.pipeThrough(new ZlibTransformStream(zlib.createBrotliDecompress(), -1, 0));
			if(contentEncoding == "gzip")
				readable = readable.pipeThrough(new ZlibTransformStream(zlib.createGunzip(), -1, 0));
			if(contentEncoding == "deflate")
				readable = readable.pipeThrough(new ZlibTransformStream(zlib.createInflate(), -1, 0));
			for(const modifiers of modifiersStack) {
				const trumpetStream = trumpet();
				for(const modifier of modifiers)
					trumpetStream.selectAll(modifier.query, modifier.func);
				readable = readable.pipeThrough(new TrumpetTransformStream(trumpetStream));
			}
			if(contentEncoding == "br")
				readable = readable.pipeThrough(new ZlibTransformStream(zlib.createBrotliCompress(), 500, 65536));
			if(contentEncoding == "gzip")
				readable = readable.pipeThrough(new ZlibTransformStream(zlib.createGzip(), 500, 65536));
			if(contentEncoding == "deflate")
				readable = readable.pipeThrough(new ZlibTransformStream(zlib.createDeflate(), 500, 65536));
			return readable;
		});
	};
	if(stream.flushHeaders != null) {
		const originalFlushHeaders = stream.flushHeaders.bind(stream);
		const originalWrite = stream.write.bind(stream);
		const originalEnd = stream.end.bind(stream);
		let tapPrepared = false;
		const prepareTap = () => {
			if(tapPrepared) return;
			tapPrepared = true;
			stream.flushHeaders = originalFlushHeaders;
			stream.write = originalWrite;
			stream.end = originalEnd;
			if(isHtml) {
				stream.removeHeader("content-length");
				initStream();
			}
		};
		stream.flushHeaders = () => {
			inspectHeader();
			prepareTap();
			// stream.flushHeaders is different after tapping
			stream.flushHeaders();
		};
		stream.write = (data, encoding, callback) => {
			inspectHeader();
			prepareTap();
			// stream.write is different after tapping
			stream.write(data, encoding, callback);
		};
		stream.end = (data, encoding, callback) => {
			inspectHeader();
			prepareTap();
			// stream.end is different after tapping
			stream.end(data, encoding, callback);
		};
	} else {
		// TODO
		// console.log(Object.keys(stream));
	}
}
function getTrumpetModifiers(modifiers, { requestProtocol }) {
	const requestModifiersStack = [];
	const responseModifiersStack = [];
	let requestModifiers;
	let responseModifiers;
	requestModifiersStack.push(requestModifiers = []);
	responseModifiersStack.push(responseModifiers = []);
	requestProtocol = `${requestProtocol}:`;

	const err = (cb, err = () => null) => (...args) => { try { return cb(...args) } catch(e) { return err(e, ...args); } };
	const rewriteElementProperty = (node, propertyName, modifier) => {
		err(() => {
			node.getAttribute(propertyName, err(propertyValue => {
				const modifiedProperty = modifier(propertyValue);
				if(modifiedProperty == undefined || modifiedProperty == propertyValue) return;
				node.setAttribute(propertyName, modifiedProperty);
			}));
		})();
	};
	const rewriteElementInner = (node, modifier) => {
		const readStream = node.createReadStream();
		const writeStream = node.createWriteStream();
		let innerHtml = "";
		readStream.on("data", err(data => innerHtml += data.toString("utf-8")));
		readStream.on("end", err(() => {
			writeStream.end(err(() => {
				const modifiedInnerHtml = modifier(innerHtml);
				if(modifiedInnerHtml == undefined || modifiedInnerHtml == "")
					return undefined;
				return modifiedInnerHtml;
			}, () => innerHtml)());
		}));
	};
	for(const modifier of modifiers) {
		if(modifier.name == "newStack") {
			if(requestModifiers.length > 0)
				requestModifiersStack.push(requestModifiers = []);
			if(responseModifiers.length > 0)
				responseModifiersStack.push(responseModifiers = []);
		}
		if(modifier.name == "httpsResource") {
			const hosts = (modifier.host instanceof Array ? modifier.host : [modifier.host])
				.filter(h => typeof h == "string");
			const modifierFn = err(v => {
				const url = new URL(v, "http://n");
				if(!hosts.includes(url.host) || url.protocol == requestProtocol) return;
				url.protocol = requestProtocol;
				return url.href;
			});
			responseModifiers.push({
				query: `script[src]`,
				func: (node) => rewriteElementProperty(node, "src", modifierFn)
			});
			responseModifiers.push({
				query: `link[href]`,
				func: (node) => rewriteElementProperty(node, "href", modifierFn)
			});
			responseModifiers.push({
				query: `img[src]`,
				func: (node) => rewriteElementProperty(node, "src", modifierFn)
			});
			responseModifiers.push({
				query: `a[href]`,
				func: (node) => rewriteElementProperty(node, "href", modifierFn)
			});
			responseModifiers.push({
				query: `form[action]`,
				func: (node) => rewriteElementProperty(node, "action", modifierFn)
			});
		}
		if(modifier.name == "rewriteHostResource") {
			const rewrites = (modifier.rewrite instanceof Array ? modifier.rewrite : [modifier.rewrite])
				.filter(r => r.from != null && r.to != null);
			const modifierFn = err(v => {
				for(const rewrite of rewrites) {
					try {
						const url = new URL(v, "http://n");
						if(rewrite.from != url.host) continue;
						url.host = rewrite.to;
						return url.href;
					} catch(_) {
						continue;
					}
				}
			});
			responseModifiers.push({
				query: `script[src]`,
				func: (node) => rewriteElementProperty(node, "src", modifierFn)
			});
			responseModifiers.push({
				query: `link[href]`,
				func: (node) => rewriteElementProperty(node, "href", modifierFn)
			});
			responseModifiers.push({
				query: `img[src]`,
				func: (node) => rewriteElementProperty(node, "src", modifierFn)
			});
			responseModifiers.push({
				query: `a[href]`,
				func: (node) => rewriteElementProperty(node, "href", modifierFn)
			});
			responseModifiers.push({
				query: `form[action]`,
				func: (node) => rewriteElementProperty(node, "action", modifierFn)
			});
		}
		if(modifier.name == "unstableScriptHttps") {
			const hosts = (modifier.host instanceof Array ? modifier.host : [modifier.host])
				.filter(h => typeof h == "string");
			const modifierFn = err(content => {
				let regex, modifiedContent;
				regex = /(?:(?:[-a-zA-Z0-9+.]+:\/\/)|(?:www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.?[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gm;
				modifiedContent = regexReplace(regex, content, err(matcher => {
					const url = new URL(matcher[0], "http://n");
					if(!hosts.includes(url.host) || url.protocol == requestProtocol) return matcher[0];
					url.protocol = requestProtocol;
					return url.href;
				}), (_, m) => m[0]);
				regex = /(?:(["'`])(?:[-a-zA-Z0-9+.]+:\\?\/\\?\/)|(?:www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.?[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\\\/=]*\1)/gm;
				modifiedContent = regexReplace(regex, content, err(matcher => {
					const url = new URL(JSON.parse(matcher[0].replaceAll("'", "\"")), "http://n");
					if(!hosts.includes(url.host) || url.protocol == requestProtocol) return matcher[0];
					url.protocol = requestProtocol;
					return JSON.stringify(url.href);
				}), (_, m) => m[0]);
				return modifiedContent;
			});
			responseModifiers.push({
				query: `script`,
				func: (node) => rewriteElementInner(node, modifierFn)
			});
			responseModifiers.push({
				query: `style`,
				func: (node) => rewriteElementInner(node, modifierFn)
			});
			responseModifiers.push({
				query: `*[style]`,
				func: (node) => rewriteElementProperty(node, "style", modifierFn)
			});
		}
		if(modifier.name == "unstableScriptRewriteHost") {
			const rewrites = (modifier.rewrite instanceof Array ? modifier.rewrite : [modifier.rewrite])
				.filter(r => r.from != null && r.to != null);
			const modifierFn = err(content => {
				let regex, modifiedContent;
				regex = /(?:(?:[-a-zA-Z0-9+.]+:\/\/)|(?:www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.?[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gm;
				modifiedContent = regexReplace(regex, content, err(matcher => {
					for(const rewrite of rewrites) {
						try {
							const url = new URL(matcher[0], "http://n");
							if(rewrite.from != url.host) continue;
							url.host = rewrite.to;
							return url.href;
						} catch(_) {
							continue;
						}
					}
					return matcher[0];
				}), (_, m) => m[0]);
				regex = /(?:(["'`])(?:[-a-zA-Z0-9+.]+:\\?\/\\?\/)|(?:www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.?[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\\\/=]*\1)/gm;
				modifiedContent = regexReplace(regex, content, err(matcher => {
					for(const rewrite of rewrites) {
						try {
							const url = new URL(JSON.parse(matcher[0].replaceAll("'", "\"")), "http://n");
							if(rewrite.from != url.host) continue;
							url.host = rewrite.to;
							return JSON.stringify(url.href);
						} catch(_) {
							continue;
						}
					}
					return matcher[0];
				}), (_, m) => m[0]);
				return modifiedContent;
			});
			responseModifiers.push({
				query: `script`,
				func: (node) => rewriteElementInner(node, modifierFn)
			});
			responseModifiers.push({
				query: `style`,
				func: (node) => rewriteElementInner(node, modifierFn)
			});
			responseModifiers.push({
				query: `*[style]`,
				func: (node) => rewriteElementProperty(node, "style", modifierFn)
			});
		}
	}
	return (req, res) => {
		trumpetStreamModifier(req, requestModifiersStack);
		trumpetStreamModifier(res, responseModifiersStack);
	};
}

async function proxyRequest(req, res, upgradeHead, reqBody) {
	if(req.headers["x-connect-token"] != process.env.HTTP_FORWARDER_CONNECT_TOKEN)
		throw new HTTPError(400, "Bad token");
	const requestProtocol = (req.headers["x-forwarded-proto"] || req.protocol).split(",").map(l => l.trim()).at(-1);
	const requestIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",").map(l => l.trim()).at(-1);
	const targetProto = req.headers["x-connect-proto"] || "http";
	const targetHost = req.headers["x-connect-host"];
	const targetPort = req.headers["x-connect-port"];
	const targetHostname = req.headers["x-connect-hostname"] || targetHost;
	const targetUri = req.headers["x-connect-uri"] || req.uri || "/";
	if(!["https", "http"].includes(targetProto))
		throw new HTTPError(400, "Invalid connect headers.");
	let trumpetModifiers = null;
	if(req.headers["x-trumpet-modifiers"]) {
		try {
			trumpetModifiers = getTrumpetModifiers(JSON.parse(req.headers["x-trumpet-modifiers"]), { requestProtocol });
		} catch(e) {
			throw new HTTPError(400, `Invalid trumpet modifiers, ${e.message}`);
		}
	}
	if(trumpetModifiers != null)
		trumpetModifiers(req, res);
	console.log(`[REQUEST]: ${requestIp}: (${requestProtocol}) ${targetProto}://${targetHostname}:${targetPort}${targetUri}`);
	const promiseResolvers = Promise.withResolvers();
	const proxy = httpProxy.createProxy({
		agent: targetProto == "https" ? proxyHttpsAgent : proxyHttpAgent,
		target: `${targetProto}://${targetHost}:${targetPort}${!!req.headers["x-connect-uri"] ? req.headers["x-connect-uri"] : ""}`,
		ws: true,
		xfwd: true,
		changeOrigin: false,
		ignorePath: !!req.headers["x-connect-uri"],
		followRedirects: false
	});
	proxy.on("proxyReq", proxyReq => {
		if(res.destroyed) {
			proxyReq.destroy();
			res.destroy();
			return;
		}
		const cleanup = (err) => {
			res.removeListener("error", cleanup);
			res.removeListener("close", cleanup);
			proxyReq.destroy(err);
			res.destroy(err);
		};
		res.addListener("error", cleanup);
		res.addListener("close", cleanup);
		proxyReq.setHeader("host", targetHostname);
		proxyReq.setHeader("x-real-ip", requestIp);
		proxyReq.setHeader("x-forwarded-for", requestIp);
		proxyReq.setHeader("x-forwarded-proto", requestProtocol);
		proxyReq.removeHeader("x-connect-token");
		proxyReq.removeHeader("x-connect-host");
		proxyReq.removeHeader("x-connect-port");
		proxyReq.removeHeader("x-connect-hostname");
		proxyReq.removeHeader("x-connect-proto");
		proxyReq.removeHeader("x-trumpet-modifiers");
		proxyReq.removeHeader("x-forwarded-host");
		proxyReq.removeHeader("cdn-loop");
		proxyReq.removeHeader("cf-connecting-ip");
		proxyReq.removeHeader("cf-ipcountry");
		proxyReq.removeHeader("cf-ray");
		proxyReq.removeHeader("cf-visitor");
		proxyReq.removeHeader("cf-warp-tag-id");
		proxyReq.once("close", () => promiseResolvers.resolve(true));
	});
	proxy.on("proxyReqWs", proxyReq => {
		proxyReq.once("close", () => promiseResolvers.resolve(true));
	});
	proxy.on("proxyRes", proxyRes => {
		if(proxyRes.destroyed || res.destroyed) {
			proxyRes.destroy();
			res.destroy();
			return;
		}
		const cleanup = (err) => {
			proxyRes.removeListener("error", cleanup);
			proxyRes.removeListener("close", cleanup);
			res.removeListener("error", cleanup);
			res.removeListener("close", cleanup);
			proxyRes.destroy(err);
			req.destroy(err);
		};
		proxyRes.addListener("error", cleanup);
		proxyRes.addListener("close", cleanup);
		res.addListener("error", cleanup);
		res.addListener("close", cleanup);
	});
	proxy.on("error", err => {
		console.error(`[REQUEST]: ${requestIp}: (${requestProtocol}) Failed to proxy ${targetProto}://${targetHostname}:${targetPort}${targetUri}`, err.message);
		if(err.code == "ETIMEDOUT" || err.message.includes("timeout")) {
			promiseResolvers.reject(new HTTPError(504, "Gateway Timed Out"));
			return;
		}
		if(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", 
			"ECONNRESET", "ECONNABORTED", "ENOTFOUND", "EPIPE", 
			"ERR_HTTP_INVALID_HEADER", "HPE_INVALID_HEADER_TOKEN"].includes(err.code) || 
			err.message.includes("Parse Error") || err.message.includes("socket hang up")) {
			promiseResolvers.reject(new HTTPError(502, "Bad Gateway"));
			return;
		}
		promiseResolvers.reject(new HTTPError(500, "Internal Server Error"));
	});
	if(upgradeHead)
		proxy.proxyWebsocketRequest(req, res, upgradeHead);
	else
		proxy.proxyRequest(req, res, { buffer: reqBody });
	return await promiseResolvers.promise;
}

const throwResponseErrorIfPossible = (status, message, res) => {
	if(res.closed || res.destroyed)
		return;
	if(res.headersSent) {
		res.end();
		return;
	}
	res.statusCode = status;
	res.end(message);
};
const throwSocketErrorIfPossible = (status, message, socket) => {
	if(socket.destroyed)
		return;
	socket.destroy();
};

if(cluster.isPrimary) {
	for(let i = 0; i < os.availableParallelism(); i++)
		cluster.fork();
	cluster.on("exit", (worker, code, signal) => {
		console.warn(`Worker ${worker.process.pid} died with code ${code}${signal != null ? ` ${signal}` : ""}`);
		setTimeout(() => cluster.fork(), 1000 * 15);
	});
} else {
	const httpServer = http.createServer((req, res) => {
		proxyRequest(req, res).catch(e => {
			if(e instanceof HTTPError) {
				throwResponseErrorIfPossible(e.httpCode, e.message, res);
				return;
			}
			throwResponseErrorIfPossible(500, "Internal Server Error", res);
			throw e;
		});
	});
	httpServer.listen(PORT, () => {
		console.log(`HTTP Server listening to 0.0.0.0:${PORT}`);
	});
	httpServer.on("upgrade", (req, socket, head) => {
		proxyRequest(req, socket, head).catch(e => {
			if(e instanceof HTTPError) {
				throwSocketErrorIfPossible(e.httpCode, e.message, socket);
				return;
			}
			throwSocketErrorIfPossible(500, "Internal Server Error", socket);
			throw e;
		});
	});
}
