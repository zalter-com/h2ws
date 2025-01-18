const levels = ["debug", "info", "warn", "error", "log", "mandatory"];

/**
 *
 * @param configs
 * @param {"debug" | "info"| "warn" | "error"| "log" | "mandatory" | number} configs.level - The level of the logger. Can be a string or a number.
 * @returns {{log: {(message?: any, ...optionalParams: any[]): void, (...data: any[]): void}, info: {(message?: any, ...optionalParams: any[]): void, (...data: any[]): void}, warn: {(message?: any, ...optionalParams: any[]): void, (...data: any[]): void}, error: {(message?: any, ...optionalParams: any[]): void, (...data: any[]): void}, debug: {(message?: any, ...optionalParams: any[]): void, (...data: any[]): void}, mandatory: {(message?: any, ...optionalParams: any[]): void, (...data: any[]): void}}}
 */
export const getConsoleLogger = (configs) => {
	const outputLogger = {
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
		log: console.log,
		mandatory: console.log
	};
	let levelIndex = 0;
	if (typeof configs.level === "number") {
		if (configs.level < 0 || configs.level >= levels.length) {
			throw new Error("Invalid level index");
		}
		levelIndex = configs.level;
	} else if (typeof configs.level === "string") {
		levelIndex = levels.indexOf(configs.level);
		if (levelIndex === -1) {
			throw new Error("Invalid level string");
		}
	}
	console.log("Level Index", levelIndex);
	levels.forEach((level, index) => {
		if (index < levelIndex) {
			outputLogger[level] = () => {};
		}
	});
	return outputLogger;
};
