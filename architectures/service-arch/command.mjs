import http2 from "node:http2";
import {Service} from "./service.mjs";

/**
 * A command is a service that has a single (default) handler. It ignores the headers of the incoming stream for the purpose of identifying the handler.
 */
export class Command extends Service{
	/**
	 *
	 * @param config
	 * @param {function} config.handler
	 * @param {function[]} config.preHandlers
	 * @param {function[]} config.postHandlers
	 * @param {Console?} config.logger
	 *
	 */
	constructor(config){
		if(config.handler === undefined){
			throw new Error("handler is required");
		}
		super({
			identifier: Service.DefaultSymbol,
			header: Service.IgnoreHeaderSymbol,
			logger: config.logger,
			preHandlers: config.preHandlers || [],
			postHandlers: config.postHandlers || []
		});
		this[Service.DefaultSymbol] = config.handler;
	}

	[Service.ErrorSymbol](transport, error){
		this.logger.error(error);
		transport.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_INTERNAL_SERVER_ERROR
		}, {endStream: true});
	}

}
