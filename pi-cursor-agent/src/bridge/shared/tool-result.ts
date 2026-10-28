import type {
  ImageContent,
  TextContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

export interface DecodedImage {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}

/** Decode a Pi ImageContent block (base64 data) into raw bytes. */
export function decodeImageContent(image: ImageContent): DecodedImage | null {
  if (!image.data || !image.mimeType) return null;
  try {
    const decoded = Buffer.from(image.data, "base64");
    if (decoded.length === 0) return null;
    // Fresh ArrayBuffer-backed copy for protobuf typings.
    const bytes = new Uint8Array(decoded.length);
    bytes.set(decoded);
    return { bytes, mimeType: image.mimeType };
  } catch {
    return null;
  }
}

/** First successfully decoded image in a tool result, if any. */
export function toolResultPrimaryImage(
  result: ToolResultMessage,
): DecodedImage | null {
  for (const item of result.content) {
    if (item.type !== "image") continue;
    const decoded = decodeImageContent(item);
    if (decoded) return decoded;
  }
  return null;
}

/** All successfully decoded images in a content list. */
export function decodeImagesFromContent(
  content: readonly (TextContent | ImageContent)[],
): DecodedImage[] {
  const images: DecodedImage[] = [];
  for (const item of content) {
    if (item.type !== "image") continue;
    const decoded = decodeImageContent(item);
    if (decoded) images.push(decoded);
  }
  return images;
}

export function toolResultToText(result: ToolResultMessage): string {
  return result.content
    .map((item: TextContent | ImageContent) => {
      if (item.type === "text") return item.text;
      return `[${item.mimeType} image]`;
    })
    .join("\n");
}

export function toolResultWasTruncated(result: ToolResultMessage): boolean {
  if (!result.details || typeof result.details !== "object") {
    return false;
  }
  const truncation = (
    result.details as { truncation?: { truncated?: boolean } }
  ).truncation;
  return !!truncation?.truncated;
}

export function toolResultDetailBoolean(
  result: ToolResultMessage,
  key: string,
): boolean {
  if (!result.details || typeof result.details !== "object") {
    return false;
  }
  const value = (result.details as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : false;
}
