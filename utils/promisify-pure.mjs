/**
 * Turns a callback function into a promise. This is mostly because the Node.js version of promisify is not reliable in all situations.
 * @param {function} originalFunction
 * @returns {function(...[*]): Promise<unknown>}
 */
export const promisify = (originalFunction) => (...args) => new Promise((resolve, reject) => {
	originalFunction(...args, (err, ...results) => {
		if (err) reject(err);
		if (results.length < 2) return resolve(...results);
		resolve(results);
	});
});
