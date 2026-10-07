import { assistanceLevel } from "./assistance.js";
export const BACKEND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: {
      type: "string",
      enum: ["answer", "proposal", "clarification", "cancelled"],
    },
    summary: { type: "string" },
    edits: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          oldText: { type: "string" },
          newText: { type: "string" },
        },
        required: ["oldText", "newText"],
      },
    },
  },
  required: ["status", "summary", "edits"],
};
export const INLINE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { insertion: { type: "string" } },
  required: ["insertion"],
};

export function backendSchema(level?: number) {
  if (assistanceLevel(level) !== 0) return BACKEND_SCHEMA;
  return {
    ...BACKEND_SCHEMA,
    properties: {
      ...BACKEND_SCHEMA.properties,
      status: {
        type: "string",
        enum: ["answer", "clarification", "cancelled"],
      },
      edits: { ...BACKEND_SCHEMA.properties.edits, maxItems: 0 },
    },
  };
}
