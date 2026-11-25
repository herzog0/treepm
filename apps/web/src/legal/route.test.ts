import { describe, expect, it } from "vitest";
import { legalDocumentForPath } from "./documents.js";

describe("legalDocumentForPath", () => {
  it.each([["/termos", "terms"], ["/termos/", "terms"], ["/privacidade", "privacy"], ["/privacidade/", "privacy"]])("%s opens the %s document", (path, id) => {
    expect(legalDocumentForPath(path)?.id).toBe(id);
  });

  it.each(["/", "/termos/x", "/termos.html", "/privacidades", "/github/callback", "/Termos", ""])("%s is not a public document", (path) => {
    expect(legalDocumentForPath(path)).toBeNull();
  });
});
