import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/** Reads image files off the machine for the window: a window cannot touch the disk itself. */
export const MediaIpc = Ipc.define({
  // A token id must be the plugin's id (its package name) or start with it.
  id: "opencode-session-media.files",
  methods: {
    read: {
      input: Schema.String,
      output: Schema.Struct({
        mime: Schema.String,
        /** The file's bytes, base64 encoded. */
        data: Schema.String,
      }),
    },
    /**
     * A downscaled copy of a PNG or JPEG, its longest side at most `maxSize`, for
     * grid tiles. `null` means "use the original": the image is already small, or
     * is a format the system cannot resize (GIF keeps its animation, WebP is not
     * supported by the image API).
     */
    thumb: {
      input: Schema.Struct({ path: Schema.String, maxSize: Schema.Number }),
      output: Schema.NullOr(Schema.Struct({ mime: Schema.String, data: Schema.String })),
    },
    /**
     * Pixel size of each image file, read from the header alone, in the order
     * asked. A file that is missing or unreadable answers 0 × 0. The layout needs
     * every shape up front so tiles do not move as images load. `exists` tells a
     * missing file from one that is there but whose size is unknown (both 0 × 0).
     */
    measure: {
      input: Schema.Array(Schema.String),
      output: Schema.Array(
        Schema.Struct({ width: Schema.Number, height: Schema.Number, exists: Schema.Boolean }),
      ),
    },
    /**
     * Write bytes the app already holds (an attachment, a `read` result) to a
     * temp file, so the system viewer has a path to open. Returns that path.
     */
    stage: {
      input: Schema.Struct({
        mime: Schema.String,
        /** The file's bytes, base64 encoded. */
        data: Schema.String,
      }),
      output: Schema.String,
    },
  },
})
