import url from "url";
import path from "path";
import http from "http";
import https from "https";
import express from "express";
import consoleStamp from "console-stamp";
import httpProxy from "http-proxy";
import trumpet from "@gofunky/trumpet";
import zlib from "zlib";
import EventEmitter from "events";
consoleStamp(console, { format: ":date(mm/dd HH:MM:ss.l) :label" });

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const proxyHttpAgent = new http.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000
});
const proxyHttpsAgent = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 30 * 1000
});

class HTTPError extends Error {
	constructor(code, message) {
		super(message);
		this.httpCode = code;
		this.stack = "";
	}
}

function trumpetStreamModifier(stream, modifiers, { skipDecoding = false, skipEncoding = false } = {}) {
	let headerInspected = false;
	let isHtml;
	let contentEncoding;
	function inspectHeader() {
		if(headerInspected) return;
		headerInspected = true;
		const headers = stream.getHeaders();
		isHtml = (headers["content-type"] || "").toLowerCase().includes("text/html");
		contentEncoding = (headers["content-encoding"] || "").toLowerCase();
	}
	let streamInitiated = false;
	let streamWrite;
	let streamEnd;
	let trumpetStream;
	let decodeStream;
	let encodeStream;
	function initStream() {
		if(streamInitiated) return;
		streamInitiated = true;
		trumpetStream = trumpet();
		if(skipDecoding) {
			decodeStream = new EventEmitter();
			decodeStream.write = (data, encoding) => decodeStream.emit("data", Buffer.from(data, encoding));
			decodeStream.flush = (cb) => process.nextTick(cb);
			decodeStream.close = () => decodeStream.emit("close");
		}
		if(skipEncoding) {
			encodeStream = new EventEmitter();
			encodeStream.write = (data, encoding) => encodeStream.emit("data", Buffer.from(data, encoding));
			encodeStream.flush = (cb) => process.nextTick(cb);
			encodeStream.close = () => encodeStream.emit("close");
		}
		if(contentEncoding == "br") {
			if(decodeStream == null)
				decodeStream = zlib.createBrotliDecompress();
			if(encodeStream == null)
				encodeStream = zlib.createBrotliCompress();
		} else if(contentEncoding == "gzip") {
			if(decodeStream == null)
				decodeStream = zlib.createGunzip();
			if(encodeStream == null)
				encodeStream = zlib.createGzip();
		} else if(contentEncoding == "deflate") {
			if(decodeStream == null)
				decodeStream = zlib.createInflate();
			if(encodeStream == null)
				encodeStream = zlib.createDeflate();
		} else {
			if(decodeStream == null) {
				decodeStream = new EventEmitter();
				decodeStream.write = (data, encoding) => decodeStream.emit("data", Buffer.from(data, encoding));
				decodeStream.flush = (cb) => process.nextTick(cb);
				decodeStream.close = () => decodeStream.emit("close");
			}
			if(encodeStream == null) {
				encodeStream = new EventEmitter();
				encodeStream.write = (data, encoding) => encodeStream.emit("data", Buffer.from(data, encoding));
				encodeStream.flush = (cb) => process.nextTick(cb);
				encodeStream.close = () => encodeStream.emit("close");
			}
		}
		for(const modifier of modifiers)
			trumpetStream.selectAll(modifier.query, modifier.func);
		decodeStream.on("data", data => trumpetStream.write(data));
		decodeStream.on("close", () => trumpetStream.end());
		trumpetStream.on("data", data => encodeStream.write(data));
		trumpetStream.on("end", () => encodeStream.flush(() => encodeStream.close()));
		encodeStream.on("data", data => streamWrite(data));
		encodeStream.on("close", () => streamEnd());
	}
	if(stream.flushHeaders != null) {
		const originalSetHeader = stream.setHeader.bind(stream);
		const originalFlushHeaders = stream.flushHeaders.bind(stream);
		const originalWrite = streamWrite = stream.write.bind(stream);
		const originalEnd = streamEnd = stream.end.bind(stream);
		stream.setHeader = (name, value) => {
			originalSetHeader(name, value);
			inspectHeader();
			headerInspected = false;
			if(isHtml)
				stream.removeHeader("content-length");
		};
		stream.flushHeaders = () => {
			inspectHeader();
			if(isHtml)
				stream.removeHeader("content-length");
			originalFlushHeaders();
		};
		stream.write = (data, encoding) => {
			inspectHeader();
			if(!isHtml)
				return originalWrite(data, encoding);
			initStream();
			return decodeStream.write(Buffer.from(data, encoding));
		};
		stream.end = (data, encoding) => {
			inspectHeader();
			if(!isHtml)
				return originalEnd(data, encoding);
			initStream();
			if(data != null)
				decodeStream.write(Buffer.from(data, encoding));
			decodeStream.flush(() => decodeStream.close());
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
				if(modifiedInnerHtml == undefined || modifiedInnerHtml == "" || modifiedInnerHtml == innerHtml)
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
				const regex = /(?:(?:[-a-zA-Z0-9+.]+:\/\/)|(?:www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.?[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gm;
				const modifiedContent = regexReplace(regex, content, err(matcher => {
					const url = new URL(matcher[0], "http://n");
					if(!hosts.includes(url.host) || url.protocol == requestProtocol) return matcher[0];
					url.protocol = requestProtocol;
					return url.href;
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
				const regex = /(?:(?:[-a-zA-Z0-9+.]+:\/\/)|(?:www\.))[-a-zA-Z0-9@:%._\+~#=]{1,256}\.?[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/gm;
				const modifiedContent = regexReplace(regex, content, err(matcher => {
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
		for(let i = requestModifiersStack.length - 1; i >= 0; i--) {
			const requestModifiers = requestModifiersStack[i];
			const skipDecoding = i != 0;
			const skipEncoding = i != responseModifiersStack.length - 1;
			trumpetStreamModifier(req, requestModifiers, { skipDecoding, skipEncoding });
		}
		for(let i = responseModifiersStack.length - 1; i >= 0; i--) {
			const responseModifiers = responseModifiersStack[i];
			const skipDecoding = i != 0;
			const skipEncoding = i != responseModifiersStack.length - 1;
			trumpetStreamModifier(res, responseModifiers, { skipDecoding, skipEncoding });
		}
	};
}

function isValidHttpUrl(string, protocols) {
	try {
		const url = new URL(string);
		if(protocols != null)
			return protocols.map(x => `${x.toLowerCase()}:`).includes(url.protocol);
		return true;
	} catch(_) {
		return false;
	}
}
async function proxyRequest(req, res, upgradeHead, reqBody) {
	const requestIp = (req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",").map(l => l.trim()).at(-1);
	const requestProtocol = (req.headers["x-forwarded-proto"] || req.protocol).split(",").map(l => l.trim()).at(-1);
	const token = req.headers["x-connect-token"];
	if(token != process.env.HTTP_FORWARDER_CONNECT_TOKEN)
		throw new HTTPError(400, "Bad token");
	const targetHost = req.headers["x-connect-host"];
	const targetPort = req.headers["x-connect-port"];
	const targetHostname = req.headers["x-connect-hostname"] || targetHost;
	const targetProto = req.headers["x-connect-proto"] || "http";
	const targetUri = req.headers["x-connect-uri"] || "/";
	const targetUrl = `${targetProto}://${targetHost}:${targetPort}${targetUri}`;
	if(!isValidHttpUrl(targetUrl, ["https", "http"]))
		throw new HTTPError(400, "Invalid connect headers.");
	const trumpetModifiers = (() => { 
		if(!req.headers["x-trumpet-modifiers"]) return null;
		let modifiers;
		try {
			modifiers = JSON.parse(req.headers["x-trumpet-modifiers"]);
		} catch(e) {
			throw new HTTPError(400, `Invalid trumpet modifiers, ${e.message}`);
		}
		return getTrumpetModifiers(modifiers, { requestProtocol });
	})();
	console.log(`[REQUEST]: ${requestIp}: (${requestProtocol}) ${targetUrl}`);
	const agent = targetProto == "https" ? proxyHttpsAgent : proxyHttpAgent;
	const proxy = httpProxy.createProxy({
		target: targetUrl,
		changeOrigin: false,
		ignorePath: true,
		xfwd: true,
		ws: true,
		followRedirects: false,
		agent: agent
	});
	proxy.on("proxyReq", (r) => {
		r.setHeader("host", targetHostname);
		r.setHeader("x-real-ip", requestIp);
		r.setHeader("x-forwarded-for", requestIp);
		r.setHeader("x-forwarded-proto", requestProtocol);
		r.removeHeader("x-connect-token");
		r.removeHeader("x-connect-host");
		r.removeHeader("x-connect-port");
		r.removeHeader("x-connect-hostname");
		r.removeHeader("x-connect-proto");
		r.removeHeader("x-connect-uri");
		r.removeHeader("x-trumpet-modifiers");
		r.removeHeader("x-forwarded-host");
		r.removeHeader("cdn-loop");
		r.removeHeader("cf-connecting-ip");
		r.removeHeader("cf-ipcountry");
		r.removeHeader("cf-ray");
		r.removeHeader("cf-visitor");
		r.removeHeader("cf-warp-tag-id");
	});
	if(trumpetModifiers != null)
		trumpetModifiers(req, res);
	await new Promise((proxyResolve, proxyReject) => {
		let finished = false;
		proxy.on("proxyReq", (proxyReq) => {
			res.on("close", () => proxyReq.destroy());
		});
		proxy.on("proxyRes", (proxyRes) => {
			if(res.destroyed) proxyRes.destroy();
			else res.on("close", () => proxyRes.destroy());
		});
		proxy.on("proxyRes", (proxyRes, innerReq, innerRes) => {
			const cleanup = (err) => {
				proxyRes.removeListener("error", cleanup);
				proxyRes.removeListener("close", cleanup);
				innerRes.removeListener("error", cleanup);
				innerRes.removeListener("close", cleanup);
				innerReq.destroy(err);
				proxyRes.destroy(err);
			}
			proxyRes.once("error", cleanup);
			proxyRes.once("close", cleanup);
			innerRes.once("error", cleanup);
			innerRes.once("close", cleanup);
		});
		proxy.on("error", (err) => {
			console.error(`[REQUEST]: ${requestIp}: (${requestProtocol}) Failed to proxy ${targetUrl}`, err.message);
			if(finished) return;
			finished = true;
			const message = err.message;
			if(message.includes("ECONNRESET") || message.includes("ECONNABORTED") || message.includes("ECONNREFUSED")) {
				proxyReject(new HTTPError(504, "Gateway Timed Out"));
				return;
			}
			if(message.includes("Parse Error")) {
				proxyReject(new HTTPError(502, "Bad Gateway"));
				return;
			}
			proxyReject(new HTTPError(500, "Internal Server Error"));
		});
		if(upgradeHead) {
			proxy.on("proxyReqWs", (proxyReq) => {
				proxyReq.on("close", () => {
					if(finished) return;
					finished = true;
					proxyResolve(true);
				});
			});
			proxy.ws(req, res, upgradeHead)
			proxyResolve(true);
		} else {
			proxy.on("proxyReq", (proxyReq) => {
				proxyReq.on("close", () => {
					if(finished) return;
					finished = true;
					proxyResolve(true);
				});
			});
			proxy.web(req, res, {
				buffer: reqBody
			});
		}
	});
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
}
const throwSocketErrorIfPossible = (status, message, socket) => {
	if(socket.destroyed)
		return;
	socket.destroy();
}

const app = express();
app.use((req, res) => {
	proxyRequest(req, res).catch(e => {
		if(e instanceof HTTPError) {
			throwResponseErrorIfPossible(e.httpCode, e.message, res);
			return;
		}
		throwResponseErrorIfPossible(500, "Internal Server Error", res);
		throw e;
	});
});

if(!!process.env.PORT) {
	const PORT = process.env.PORT;
	const httpServer = http.createServer(app);
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
