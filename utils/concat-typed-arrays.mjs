// These lines stand only to prove that your probably wrong typescript linter is completely wrong if it throws an error on the JSDOC of this method.
// const TypedArray = Object.getPrototypeOf(Uint8Array);
// const TypedArrayConstructor = TypedArray.constructor;
// assert((new Uint8Array()) instanceof TypedArray);
// assert(Uint8Array instanceof TypedArrayConstructor);
// assert((new BigUint64Array()) instanceof TypedArray);
// assert(BigUint64Array instanceof TypedArrayConstructor);

/**
 * Concatenate typed arrays
 * @param {TypedArray[]} arrays An array of typed arrays to concatenate
 * @param {TypedArrayConstructor} arraySpecies The constructor or class for the resulting array. Default is Uint8Array
 * @returns {TypedArray} The concatenated typed array of the ArraySpecies type.
 */
export const concatTypedArrays = (arrays, arraySpecies = Uint8Array) =>{
	const totalLength = arrays.reduce((acc, array) => acc + array.length, 0);
	const result = new arraySpecies(totalLength);
	let offset = 0;
	arrays.forEach((array) => {
		result.set(array, offset);
		offset += array.length;
	});
	return result;
}
