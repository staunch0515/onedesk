export const textForm = (t, bind) => ({
  type: "form", id: "main", layout: "stack",
  fields: [{ name: "text", label: t("field.text"), kind: "longtext", bind, fill: true }],
});
export const baseName = (p) => p.split("/").filter(Boolean).pop() || p;
