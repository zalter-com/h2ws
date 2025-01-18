import http2 from "node:http2";

import {Service} from "../../../architectures/service-arch/service.mjs";
import {Command} from "../../../architectures/service-arch/command.mjs";
import {fileHandler} from "../../../architectures/service-arch/pre-made-handlers/file-handler.mjs";
import {serveSingleFile} from "../../../architectures/service-arch/pre-made-handlers/serve-single-file.mjs";
import {negativeHTMLoRFolder, notFoundHandler} from "../../../architectures/service-arch/pre-made-handlers/not-found-handler.mjs";

export class DefaultService extends Service {
	constructor(config) {
		super({
			identifier: Service.NotFoundSymbol,
			header: http2.constants.HTTP2_HEADER_METHOD,
			logger: config.logger || console,
			preHandlers: [],
			postHandlers: []
		});
	}

	[Service.ErrorSymbol](transport, error) {
		this.logger.error(error);
		transport.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_INTERNAL_SERVER_ERROR
		}, {endStream: true});
	}

	/**
	 * Handles a GET request.
	 * @param transport
	 */
	GET = new Command({
		handler: fileHandler({
			root: "./public",
			logger: this.logger
		}),
		preHandlers: [
				// CAN always log the request, do authentication, start measuring the request time, etc.
				// Could also filter certain request paths and respond with a different service instead.
		],
		postHandlers: [
				notFoundHandler({
					logger: this.logger,
					filter: negativeHTMLoRFolder,
					filterHeader: http2.constants.HTTP2_HEADER_PATH
				}),
				serveSingleFile({
					filePath: "./public/index.html",
					logger: this.logger
				}),
				notFoundHandler({
					logger: this.logger
				})
				// Can log the response, the time it took to respond, etc.
		]
	})
}
