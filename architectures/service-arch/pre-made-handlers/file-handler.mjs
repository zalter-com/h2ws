import * as path from "node:path";
import fs from "node:fs";
import http2 from "node:http2";
import {promisify} from "../../../utils/promisify-pure.mjs";

import mimeTypes from "mime-types";
const promisifiedFSRead = promisify(fs.read);

/**
 *
 * @param {string} configs.root Root Path.
 * @param {Console} configs.logger
 * @returns {(function(H2Stream): Promise<void>)}
 */
export const fileHandler = (configs) => {
	const basePath = path.resolve(configs.root || "./public");
	configs.logger = configs.logger || console;
	{
		// ensuring that the folder can be read.
		configs.logger.info("File Handler configured to run on ", basePath);
		// Ensure the path exists and is accessible.
		const stats = fs.statSync(basePath, {throwIfNoEntry: false});
		if (!stats || !stats.isDirectory()) {
			throw new Error("Configured Base path is not a folder or is inaccessible");
		}
	}

	/**
	 * @param {H2Stream} h2Stream
	 */
	return async (h2Stream) => {
		if (h2Stream.sentHeaders) {
			if (h2Stream.errorProtocol === "throw")
				throw new Error("Headers already sent.");
			h2Stream.logger.error("Headers already sent.");
			return;
		}
		let reqPath = path.resolve(basePath, (
				path.normalize(
						"./" + h2Stream.incomingHeaders[http2.constants.HTTP2_HEADER_PATH]
				)
		));
		configs.logger.info("Requested Path: ", reqPath);
		const fileDetails = {
			fileHandle: null,
			fileMime: null,
			finalPath: "",
		};

		// first check whether this one is a folder, get the index if it is.
		const reqStat = fs.statSync(reqPath, {throwIfNoEntry: false});
		if (!reqStat) {
			// should reach a not found handler or a retry handler.
			return;
		}

		if (reqStat.isDirectory()) {
			const indexPath = path.resolve(`${reqPath}/index.html`);
			const indexStat = fs.statSync(indexPath, {throwIfNoEntry: false});
			if (!indexStat?.isFile()) {
				// it's a non indexable folder.
				return;
			}
			fileDetails.fileHandle = fs.openSync(indexPath, "r");
			fileDetails.fileMime = mimeTypes.lookup(indexPath);
			fileDetails.finalPath = indexPath;
		} else {
			fileDetails.fileHandle = fs.openSync(reqPath, "r");
			fileDetails.fileMime = mimeTypes.lookup(reqPath);
			fileDetails.finalPath = reqPath;
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
		configs.logger.info("File sent: ", fileDetails.finalPath);
		h2Stream.end();
	};
};
