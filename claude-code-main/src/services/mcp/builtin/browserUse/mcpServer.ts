import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { BROWSER_TOOLS } from './tools.js'
import {
  getOrCreateSession,
  getActivePage,
  closeSession,
} from './session.js'

export async function createBrowserUseMcpServerInstance(): Promise<Server> {
  const server = new Server(
    { name: 'browser-use', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: BROWSER_TOOLS,
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params
    try {
      const result = await handleToolCall(name, args ?? {})
      return { content: result }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      }
    }
  })

  return server
}

async function handleToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>> {
  switch (name) {
    case 'navigate':
      return handleNavigate(args)
    case 'screenshot':
      return handleScreenshot(args)
    case 'snapshot':
      return handleSnapshot(args)
    case 'click':
      return handleClick(args)
    case 'type':
      return handleType(args)
    case 'press':
      return handlePress(args)
    case 'hover':
      return handleHover(args)
    case 'scroll':
      return handleScroll(args)
    case 'select':
      return handleSelect(args)
    case 'wait':
      return handleWait(args)
    case 'evaluate':
      return handleEvaluate(args)
    case 'tabs':
      return handleTabs(args)
    case 'upload':
      return handleUpload(args)
    case 'fill':
      return handleFill(args)
    case 'sleep':
      return handleSleep(args)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

function isSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /target.closed|session.closed|browser.has.been.closed|disconnected|protocol.error/i.test(msg)
}

async function handleNavigate(args: Record<string, unknown>) {
  const url = args.url as string
  const requestedWait = (args.waitUntil as string) ?? 'domcontentloaded'
  const timeout = (args.timeoutMs as number) ?? 60000
  const warnings: string[] = []

  // All fallback attempts + retries share a single deadline to prevent cascade.
  const totalDeadline = Date.now() + timeout

  // Graduated fallback: requested → domcontentloaded → commit
  const fallbackChain: Array<'networkidle' | 'load' | 'domcontentloaded' | 'commit'> = [
    requestedWait as 'networkidle' | 'load' | 'domcontentloaded' | 'commit',
  ]
  if (requestedWait === 'networkidle' && !fallbackChain.includes('domcontentloaded')) {
    fallbackChain.push('domcontentloaded')
  }
  if (requestedWait !== 'commit' && !fallbackChain.includes('commit')) {
    fallbackChain.push('commit')
  }

  for (let retry = 0; retry < 2; retry++) {
    const remaining = totalDeadline - Date.now()
    if (remaining <= 0) break

    const page = await getActivePage()

    for (let i = 0; i < fallbackChain.length; i++) {
      const stepRemaining = totalDeadline - Date.now()
      if (stepRemaining <= 0) break

      const waitUntil = fallbackChain[i]!
      try {
        await page.goto(url, {
          waitUntil,
          timeout: Math.min(stepRemaining, timeout),
        })

        if (i > 0) {
          warnings.push(`${fallbackChain[0]} timed out, fell back to ${waitUntil}`)
        }
        const result: Record<string, unknown> = {
          url: page.url(),
          title: await page.title(),
        }
        if (warnings.length > 0) result.warning = warnings.join('; ')
        return [{ type: 'text' as const, text: JSON.stringify(result) }]
      } catch (err) {
        if (isSessionError(err)) {
          warnings.push(`session error on attempt ${retry + 1}, reconnecting`)
          break
        }
        const isTimeout = err instanceof Error && /timeout/i.test(err.message)
        if (isTimeout && i < fallbackChain.length - 1) {
          warnings.push(`${waitUntil} timed out`)
          continue
        }
        throw err
      }
    }
  }

  throw new Error(`navigate to ${url} failed after retries (budget ${timeout}ms). ${warnings.join('; ')}`)
}

async function handleScreenshot(args: Record<string, unknown>) {
  const timeout = (args.timeoutMs as number) ?? 30000

  for (let retry = 0; retry < 2; retry++) {
    const page = await getActivePage()
    try {
      let buffer: Buffer
      if (args.selector) {
        const el = page.locator(args.selector as string)
        buffer = await el.screenshot({ timeout })
      } else {
        buffer = await page.screenshot({
          fullPage: (args.fullPage as boolean) ?? false,
          timeout,
        })
      }
      return [
        {
          type: 'image' as const,
          data: buffer.toString('base64'),
          mimeType: 'image/png',
        },
      ]
    } catch (err) {
      if (isSessionError(err) && retry === 0) continue
      throw err
    }
  }
  throw new Error('screenshot failed after retries')
}

async function handleSnapshot(args: Record<string, unknown>) {
  const page = await getActivePage()
  let snapshot: string

  if (args.selector) {
    const el = page.locator(args.selector as string)
    snapshot = await el.ariaSnapshot()
  } else {
    snapshot = await page.locator('body').ariaSnapshot()
  }

  return [{ type: 'text' as const, text: snapshot }]
}

async function handleClick(args: Record<string, unknown>) {
  const page = await getActivePage()
  const selector = args.selector as string
  const options: Record<string, unknown> = {}

  if (args.button) options.button = args.button
  if (args.position) options.position = args.position

  if (args.doubleClick) {
    await page.locator(selector).dblclick(options)
  } else {
    await page.locator(selector).click(options)
  }

  return [{ type: 'text' as const, text: JSON.stringify({ ok: true, url: page.url() }) }]
}

async function handleType(args: Record<string, unknown>) {
  const page = await getActivePage()
  const text = args.text as string
  const selector = args.selector as string | undefined

  if (selector) {
    if (args.clear) {
      await page.locator(selector).fill(text)
    } else {
      await page.locator(selector).pressSequentially(text)
    }
  } else {
    await page.keyboard.type(text)
  }

  if (args.submit) {
    await page.keyboard.press('Enter')
  }

  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handlePress(args: Record<string, unknown>) {
  const page = await getActivePage()
  await page.keyboard.press(args.key as string)
  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handleHover(args: Record<string, unknown>) {
  const page = await getActivePage()
  await page.locator(args.selector as string).hover()
  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handleScroll(args: Record<string, unknown>) {
  const page = await getActivePage()
  const direction = (args.direction as string) ?? 'down'
  const amount = (args.amount as number) ?? 500

  const deltaX = direction === 'right' ? amount : direction === 'left' ? -amount : 0
  const deltaY = direction === 'down' ? amount : direction === 'up' ? -amount : 0

  if (args.selector) {
    const el = page.locator(args.selector as string)
    await el.hover()
  }
  await page.mouse.wheel(deltaX, deltaY)

  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handleSelect(args: Record<string, unknown>) {
  const page = await getActivePage()
  const selector = args.selector as string
  const values = args.values as string[]
  await page.locator(selector).selectOption(values)
  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handleWait(args: Record<string, unknown>) {
  const page = await getActivePage()
  const timeout = (args.timeoutMs as number) ?? 30000

  if (args.selector) {
    await page.locator(args.selector as string).waitFor({ timeout })
  } else if (args.text) {
    await page.getByText(args.text as string).waitFor({ timeout })
  } else if (args.url) {
    await page.waitForURL(args.url as string, { timeout })
  } else if (args.loadState) {
    await page.waitForLoadState(
      args.loadState as 'load' | 'domcontentloaded' | 'networkidle',
      { timeout },
    )
  } else {
    throw new Error('Provide at least one of: selector, text, url, loadState')
  }

  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handleEvaluate(args: Record<string, unknown>) {
  const page = await getActivePage()
  const expression = args.expression as string
  const result = await page.evaluate(expression)
  return [
    {
      type: 'text' as const,
      text: JSON.stringify({ result }, null, 2),
    },
  ]
}

async function handleTabs(args: Record<string, unknown>) {
  const { context } = await getOrCreateSession()
  const action = args.action as string

  switch (action) {
    case 'list': {
      const pages = context.pages()
      const tabs = await Promise.all(
        pages.map(async (p, i) => {
          try {
            return { index: i, url: p.url(), title: await p.title() }
          } catch {
            return { index: i, url: p.url(), title: '(closed)' }
          }
        }),
      )
      return [{ type: 'text' as const, text: JSON.stringify({ tabs }) }]
    }
    case 'open': {
      const page = await context.newPage()
      if (args.url) {
        await page.goto(args.url as string)
      }
      return [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            index: context.pages().length - 1,
            url: page.url(),
          }),
        },
      ]
    }
    case 'close': {
      const pages = context.pages()
      const idx = args.index as number
      if (idx < 0 || idx >= pages.length) {
        throw new Error(`Tab index ${idx} out of range (0-${pages.length - 1})`)
      }
      await pages[idx]!.close()
      return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
    }
    case 'focus': {
      const pages = context.pages()
      const idx = args.index as number
      if (idx < 0 || idx >= pages.length) {
        throw new Error(`Tab index ${idx} out of range (0-${pages.length - 1})`)
      }
      await pages[idx]!.bringToFront()
      return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
    }
    default:
      throw new Error(`Unknown tab action: ${action}`)
  }
}

async function handleUpload(args: Record<string, unknown>) {
  const page = await getActivePage()
  const selector = args.selector as string
  const paths = args.paths as string[]
  await page.locator(selector).setInputFiles(paths)
  return [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: paths.length }) }]
}

async function handleFill(args: Record<string, unknown>) {
  const page = await getActivePage()
  const selector = args.selector as string
  const value = args.value as string
  await page.locator(selector).fill(value)
  return [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }]
}

async function handleSleep(args: Record<string, unknown>) {
  const page = await getActivePage()
  const ms = (args.ms as number) ?? 1000
  await page.waitForTimeout(ms)
  return [{ type: 'text' as const, text: JSON.stringify({ ok: true, ms }) }]
}
