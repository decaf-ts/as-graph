/**
 * @module as-graph/shared/ui/constants
 * @summary Minimal UI metadata keys shared with the rendering layer.
 * @description The graph reader inspects the UI decoration metadata that the
 * `@uielement`/`@uiprop` decorators attach to a model's properties. Only the
 * `UIKeys.PROP` key is consumed by the shared graph reader, but the whole key
 * object is reproduced here verbatim from `@decaf-ts/ui-decorators` so the shared
 * package stays self-contained for this trivially clean, pure constant. The
 * rendering base itself (`uimodel`, `uielement`, `RenderingEngine`) is imported
 * from `@decaf-ts/ui-decorators` — see the completion report's flagged
 * dependency.
 */
import { ValidationKeys } from "@decaf-ts/decorator-validation";

/**
 * @description Key constants used for UI metadata and rendering.
 * @summary Reproduces the `UIKeys` object from `@decaf-ts/ui-decorators` so the
 * shared graph reader can read UI decoration metadata without importing the
 * rendering base. Values must stay identical to the source package.
 * @const UIKeys
 * @readonly
 */
export const UIKeys = {
  REFLECT: `ui`,
  UIMODEL: "uimodel",
  RENDERED_BY: "rendered-by",
  ELEMENT: "uielement",
  PROP: "uiprop",
  CHILD: "uichild",
  NAME: "name",
  NAME_PREFIX: "input-",
  VALIDATION_MESSAGE: "validationMessage",

  UILISTMODEL: "uilistmodel",
  UILISTPROP: "uilistprop",
  UILAYOUT: "uilayout",
  UILAYOUTPROP: "uilayoutprop",
  HANDLERS: "handlers",

  TYPE: "type",
  SUB_TYPE: "subType",

  HIDDEN: "hidden",
  HIDE_FOR: "hide-for",
  SHOW_FOR: "show-for",
  RENDER_IF: "render-if",
  FORMAT: "format",
  ORDER: "order",
  PAGE: "page",
  EVENTS: "events",

  FIRST: "first",
  LAST: "last",

  READ_ONLY: "readonly",
  SEQUENCE: "sequence",
  REQUIRED: ValidationKeys.REQUIRED,
  MIN: ValidationKeys.MIN,
  MIN_LENGTH: ValidationKeys.MIN_LENGTH,
  MAX: ValidationKeys.MAX,
  MAX_LENGTH: ValidationKeys.MAX_LENGTH,
  PATTERN: ValidationKeys.PATTERN,
  URL: ValidationKeys.URL,
  STEP: ValidationKeys.STEP,
  DATE: ValidationKeys.DATE,
  EMAIL: ValidationKeys.EMAIL,
  PASSWORD: ValidationKeys.PASSWORD,
  EQUALS: ValidationKeys.EQUALS,
  DIFF: ValidationKeys.DIFF,
  LESS_THAN: ValidationKeys.LESS_THAN,
  LESS_THAN_OR_EQUAL: ValidationKeys.LESS_THAN_OR_EQUAL,
  GREATER_THAN: ValidationKeys.GREATER_THAN,
  GREATER_THAN_OR_EQUAL: ValidationKeys.GREATER_THAN_OR_EQUAL,
};
