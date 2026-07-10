import ts from 'typescript'
import { readFile } from 'fs/promises'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const webRoot = path.resolve(testDir, '..')

export async function resolve(specifier, context, defaultResolve) {
  if (specifier.startsWith('node:')) {
    return defaultResolve(specifier, context, defaultResolve)
  }
  if (specifier.startsWith('@/')) {
    const target = path.join(webRoot, specifier.slice(2))
    const withExt = await resolveWithExtensions(target)
    return { url: pathToFileURL(withExt).href, shortCircuit: true }
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentURL = context.parentURL ? fileURLToPath(context.parentURL) : webRoot
    const baseDir = specifier.startsWith('./test/') ? webRoot : path.dirname(parentURL)
    const resolved = path.resolve(baseDir, specifier)
    const withExt = await resolveWithExtensions(resolved)
    return { url: pathToFileURL(withExt).href, shortCircuit: true }
  }
  try {
    return await defaultResolve(specifier, context, defaultResolve)
  } catch (err) {
    if (specifier && !specifier.startsWith('file://')) {
      try {
        const candidate = path.join(webRoot, 'node_modules', specifier)
        const withExt = await resolveWithExtensions(candidate)
        return { url: pathToFileURL(withExt).href, shortCircuit: true }
      } catch {
        // fall through to rethrow original error
      }
    }
    throw err
  }
}

async function resolveWithExtensions(basePath) {
  const extensions = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs']
  for (const ext of extensions) {
    const candidate = basePath.endsWith(ext) ? basePath : `${basePath}${ext}`
    try {
      await readFile(candidate)
      return candidate
    } catch (err) {
      if (ext === extensions[extensions.length - 1]) {
        throw err
      }
    }
  }
  return basePath
}

export async function load(url, context, defaultLoad) {
  if (url.endsWith('.ts') || url.endsWith('.tsx')) {
    const source = await readFile(new URL(url), 'utf8')
    const transpiled = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        esModuleInterop: true,
        jsx: ts.JsxEmit.Preserve,
        resolveJsonModule: true,
        allowJs: false,
      },
    })
    return { format: 'module', source: transpiled.outputText, shortCircuit: true }
  }
  return defaultLoad(url, context, defaultLoad)
}
