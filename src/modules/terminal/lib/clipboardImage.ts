function isImageType(type: string | undefined): boolean {
  return typeof type === "string" && type.toLowerCase().startsWith("image/");
}

export function hasClipboardImage(
  data: DataTransfer | null | undefined,
): boolean {
  if (!data) return false;
  for (const type of data.types ?? []) {
    if (isImageType(type)) return true;
  }
  for (const item of data.items ?? []) {
    if (item.kind === "file" && isImageType(item.type)) return true;
  }
  for (const file of data.files ?? []) {
    if (isImageType(file.type)) return true;
  }
  return false;
}
