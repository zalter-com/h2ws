import fs from 'node:fs';
import {H2Server} from "../../h2server.mjs";
import {DefaultService} from "./services/default.service.mjs";
import {getConsoleLogger} from "../../utils/console-logger.mjs";

const consoleLogger = getConsoleLogger({level: "debug"});
const server = new H2Server({
	ssl: {
		key: fs.readFileSync(process.env.KEY_FILE || "./certs/key.pem"),
		cert: fs.readFileSync(process.env.CERT_FILE || "./certs/cert.pem")
	},
	port: process.env.PORT || 8443,
	logger: consoleLogger
});
const defaultService = new DefaultService({
	logger: consoleLogger
})

server.on("session", (h2Session) => {
	console.log("Session created for: ", h2Session.remoteIpAndPort);
	h2Session.on("ping", () => {
		consoleLogger.debug(`Ping received from: ${h2Session.remoteIpAndPort} with a measured latency of ${h2Session.latency}ms`);
	});
	h2Session.on("close", () => {
		consoleLogger.log("Session closed for: ", h2Session.remoteIpAndPort);
	});
	h2Session.on("error", (error) => {
		consoleLogger.error(`Session for ${h2Session.remoteIpAndPort} errored: `, error);
	});

	h2Session.on("stream", (h2Stream) => {
		if(h2Stream instanceof WsH2Stream){
			// handle the websocket stream by path.

		}
		defaultService.handle(h2Stream).catch((err) => {
			consoleLogger.log("Error handling stream: ", err);
		});
	});
})

server.listen();
