let customNativeFetch;
export function setNativeFetch(fn) {
    customNativeFetch = fn;
}
export const nativeFetch = (input, init) => {
    const impl = customNativeFetch ?? globalThis.fetch;
    return impl(input, init);
};
//# sourceMappingURL=native-fetch.js.map