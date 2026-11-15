export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (originalError) {
    const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(specifier);
    if (!isRelative || hasExtension) throw originalError;

    for (const extension of [".ts", ".js"]) {
      try {
        return await nextResolve(specifier + extension, context);
      } catch {
        // Try the next supported source extension.
      }
    }
    throw originalError;
  }
}
