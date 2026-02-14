export type GlobalPackage = {
  name: string;
  version: string;
  source: string;
  dependencies?: string[];
  fileExtension?: string;
};

// Add global UI libraries here. These are shared across all tenants.
// The code should be CommonJS and can use React via the injected parameter.
const GLOBAL_UI_PACKAGES: GlobalPackage[] = [
  // Example:
  // {
  //   name: '@shared/ui',
  //   version: '1.0.0',
  //   fileExtension: 'js',
  //   dependencies: [],
  //   source: `
  //     function Button(props) {
  //       return React.createElement(
  //         'button',
  //         { style: { padding: '8px 12px', borderRadius: '6px' }, ...props },
  //         props.children || 'Button'
  //       );
  //     }
  //     module.exports = { Button };
  //   `.trim(),
  // },
];

const compareVersions = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const resolveGlobalPackage = (
  name: string,
  version?: string,
): GlobalPackage | null => {
  const matches = GLOBAL_UI_PACKAGES.filter((pkg) => pkg.name === name);
  if (matches.length === 0) return null;
  if (!version || version === 'latest') {
    return matches.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
  }
  return matches.find((pkg) => pkg.version === version) ?? null;
};
