/** Short, known label keys for tool ids; anything else is humanized. */
export type ToolLabel =
  { readonly key: "simulator" | "browser" | "read" } | { readonly text: string }

/** Map a tool id (`simulator_screenshot`, `browse_screenshot`, `read`) to a label key or humanized text. */
export function toolLabel(tool: string): ToolLabel {
  const id = tool.toLowerCase()
  if (id.includes("simulator")) return { key: "simulator" }
  if (id.startsWith("browse")) return { key: "browser" }
  if (id === "read") return { key: "read" }
  const words = tool
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase()
  return { text: words ? words[0]!.toUpperCase() + words.slice(1) : tool }
}

/** Upper-case file extension for a badge: from the name, else the mime subtype. */
export function extensionOf(name: string | undefined, mime: string): string {
  const base = name?.split(/[\\/]/).filter(Boolean).pop()
  const dot = base ? base.lastIndexOf(".") : -1
  const ext = dot > 0 && base ? base.slice(dot + 1) : (mime.split("/")[1] ?? "")
  return ext.replace(/^x-/, "").slice(0, 5).toUpperCase()
}
