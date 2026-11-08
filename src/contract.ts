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
     * Pixel size of each image file, read from the header alone, in the order
     * asked. A file that is missing or unreadable answers 0 × 0. The layout needs
     * every shape up front so tiles do not move as images load.
     */
    measure: {
      input: Schema.Array(Schema.String),
      output: Schema.Array(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
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
