import http2 from "node:http2";

/**
 * A regular expression that matches any file that is not an HTML file or a folder.
 * @type {RegExp}
 */
export const negativeHTMLoRFolder = /^(?!.*\.(?:htm|html)$)(?=.*\..+).+/ig;
/**
 * A handler that responds with a 404 status code if the headers have not been sent.
 * Can be configured to filter requests based on a header and a regular expression. When matched the handler will be ignored.
 * @param config
 * @param {Console} config.logger The logger to use.
 * @param {RegExp} [config.filter] A regular expression to filter requests.
 * @param {string} [config.filterHeader] The header to filter.
 * @param {boolean = false} config.closeOpenStreams Whether to close the stream if it is open.
 * @returns {(function(*): void)|*}
 */
export const notFoundHandler = (config) => (h2Stream) => {
	if(config.filter && config.filter instanceof RegExp && config.filterHeader) {
		const match = h2Stream.incomingHeaders[config.filterHeader].matchAll(config.filter);
		if(!Array.from(match).length) return;
	}
	if(!h2Stream.sentHeaders){
		h2Stream.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_NOT_FOUND
		}, {endStream: true});
		return;
	}
	if(config.closeOpenStreams && !h2Stream.closed) h2Stream.end(http2.constants.NGHTTP2_REFUSED_STREAM);
}
