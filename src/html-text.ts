/** Plain text from Shopify descriptionHtml. Markup is dropped. */
export function plainTextFromHtml(html: string): string {
  const decoded = decodeEntities(html);
  const withoutBlocks = decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const withoutTags = withoutBlocks.replace(/<[^>]+>/g, " ");
  return withoutTags.replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/g, (entity, body: string) => {
    if (body === "amp") {
      return "&";
    }
    if (body === "lt") {
      return "<";
    }
    if (body === "gt") {
      return ">";
    }
    if (body === "quot") {
      return '"';
    }
    if (body === "apos") {
      return "'";
    }
    if (body === "nbsp") {
      return " ";
    }
    const code = body.startsWith("#x")
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) {
      return entity;
    }
    return String.fromCodePoint(code);
  });
}
