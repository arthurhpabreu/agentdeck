const strings = {
  fullAccess: ["Acesso total", "Full access", "Acceso total"],
  cliPermissions: ["Permissões CLI", "CLI permissions", "Permisos CLI"],
  readOnly: ["Somente leitura", "Read only", "Solo lectura"],
} satisfies Record<string, readonly [string, string, string]>;

export function composerCopy(locale: string): { [K in keyof typeof strings]: string } {
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  return Object.fromEntries(Object.entries(strings).map(([key, value]) => [key, value[index]])) as { [K in keyof typeof strings]: string };
}
