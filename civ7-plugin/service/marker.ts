// A transitive import of the service. Its value is set at build time (`dev build --marker B`) so a
// reload experiment can prove that transitive modules were re-read, not only the entry module.
export const MARKER: string = "__MARKER__";
