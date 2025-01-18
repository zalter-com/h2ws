import * as path from "node:path";
import fs from "node:fs";
import http2 from "node:http2";
import mimeTypes from "mime-types";
import {promisify} from "../../../utils/promisify-pure.mjs";
const promisifiedFSRead = promisify(fs.read);

/**
 *
 * @param {string} configs.filePath Root Path.
 * @param {Console} configs.logger
 * @returns {(function(H2Stream): Promise<void>)}
 */
export const serveSingleFile = (configs) => {
	configs.logger = configs.logger || console;
	const fileName = path.resolve(configs.filePath || "./public/index.html");
	const stats = fs.statSync(fileName, {throwIfNoEntry: false});
	if (!stats || !stats.isFile()) {
		throw new Error("Configured File path is not a file or is inaccessible");
	}

	/**
	 * @param {H2Stream} h2Stream
	 */
	return async (h2Stream) => {
		if(h2Stream.sentHeaders) {
			if(h2Stream.errorProtocol === "throw") throw new Error("Headers already sent.");
			configs.logger.error("Headers already sent.");
			return;
		}
		const fileDetails = {
			fileHandle: fs.openSync(fileName, "r"),
			fileMime: mimeTypes.lookup(fileName) || "text/html"
		}
		h2Stream.respond({
			[http2.constants.HTTP2_HEADER_STATUS]: http2.constants.HTTP_STATUS_OK,
			[http2.constants.HTTP2_HEADER_CONTENT_TYPE]: fileDetails.fileMime
		});

		let [bytesRead, buffer] = [0, null];
		while ( ([bytesRead, buffer] = await promisifiedFSRead(fileDetails.fileHandle) ) && bytesRead ) {
			h2Stream.sendData(buffer);
		}
		fs.close(fileDetails.fileHandle);
		h2Stream.end();
	};
};
