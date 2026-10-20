/**
 * Dev-only ambient declarations for the DeepSeek Harness peer modules.
 *
 * The host ships these packages without .d.ts, and the harness source tree that
 * scripts/link-peers.mjs expects is not available in a packaged install. Types here are
 * intentionally loose: they exist so `pnpm typecheck` can resolve the import specifiers and
 * catch our own rename/misspelling mistakes, not to type the host API. Runtime resolution is
 * unaffected — the built bundle keeps `@deepseek-ai/*` external and the loaded host profile
 * provides the real implementations.
 */

declare module '@deepseek-ai/schemastery' {
  /** Schemastery schemas are used as both values (`z.object`) and generic types (`z<T>`). */
  type z<T = any> = any
  const z: any
  export default z
}

declare module '@deepseek-ai/cordis' {
  class Context {
    constructor(...args: any[])
    on(event: string, listener: (...args: any[]) => any, options?: any): any
    effect(effect: () => any, label?: string): any
    inject(deps: string[], callback: (ctx: any) => any): any
    plugin(plugin: any, config?: any): any
    [key: string]: any
  }
  export { Context }
}

declare module '@deepseek-ai/dsh-llm' {
  export const createUserMessage: any
  export const BlockAssembler: any
  export type ContextFormed = any
  export type FinishReason = any
  export type GenerateOptions = any
  export type Message = any
  export interface MessageSourceMap { [kind: string]: any }
}

declare module '@deepseek-ai/dsh-agent' {
  export type Agent = any
  export type PreStepDecision = any
}

declare module '@deepseek-ai/dsh-tools' {
  interface ToolRunContext {
    [key: string]: any
  }
  interface ToolDefinition {
    name: string
    description: string
    parameters: any
    render?: (args: any, value: any) => any
    execute: (args: any, exec: ToolRunContext) => any
    [key: string]: any
  }
  export const defineTool: (definition: ToolDefinition) => any
  export const ToolRuntime: any
  export type { ToolRunContext, ToolDefinition }
}

declare module '@deepseek-ai/dsh-host-webserver' {
  const HttpServer: any
  export default HttpServer
}

declare module '@deepseek-ai/dsh-system-prompt' {
  const SystemPrompt: any
  export default SystemPrompt
}

declare module '@deepseek-ai/cordis-plugin-loader' {
  const Loader: any
  export default Loader
}

declare module '@deepseek-ai/cordis-plugin-include' {
  const Include: any
  export default Include
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  export type PropsLocale<T = any> = any
  export type PropsRuntime<T = any> = any
}

declare module '@deepseek-ai/dsh-client-ui-layout/client' {
  export type MainPanelId = any
}

declare module '@deepseek-ai/dsh-client-locale/client' {}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {}

declare module '@deepseek-ai/dsh-client-ui-sidebar/client' {}

