import { withSupabase } from 'npm:@supabase/server@^1'

const encoder = new TextEncoder()
const DIAGNOSTIC_VERSION = 'milena-diagnostics-v1'
const DIAGNOSTIC_STUDENT_ID = 'milena'
const corsHeaders = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders })
}

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false

  let diff = 0
  for (let index = 0; index < a.length; index += 1) {
    diff |= a[index] ^ b[index]
  }
  return diff === 0
}

function normalizeStudentId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function buildMessage(hasVocabulary: boolean): string {
  if (hasVocabulary) {
    return [
      '🚀 <b>Опубликованы новые материалы!</b>',
      '',
      'Сначала повтори слова к уроку — так выполнять домашнее задание будет легче. Затем переходи к упражнениям.',
      '',
      'Удачи! Запиши вопросы, и мы разберём их на следующем уроке ✨',
    ].join('\n')
  }

  return [
    '🚀 <b>Опубликовано новое домашнее задание!</b>',
    '',
    'Переходи к упражнениям. Запиши вопросы, и мы разберём их на следующем уроке.',
    '',
    'Удачи! ✨',
  ].join('\n')
}

async function telegramRequest(token: string, method: string, payload?: Record<string, unknown>) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) {
    const description = result?.description || `Telegram HTTP ${response.status}`
    throw new Error(description)
  }
  return result.result
}

async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; url: string }>> = [],
  messageThreadId: number | null = null,
) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  }

  if (messageThreadId !== null && Number.isFinite(messageThreadId)) {
    payload.message_thread_id = messageThreadId
  }

  if (inlineKeyboard.length) {
    payload.reply_markup = { inline_keyboard: inlineKeyboard }
  }

  return telegramRequest(token, 'sendMessage', payload)
}

function isDiagnosticsPayload(payload: any): boolean {
  return typeof payload?.kind === 'string' && payload.kind.startsWith('diagnostics_')
}

function authorizeDiagnostics(req: Request, studentId: string): Response | null {
  if (studentId !== DIAGNOSTIC_STUDENT_ID) {
    return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Diagnostics are not allowed for this student_id' }, 403)
  }

  const expectedAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  const actualAnonKey = req.headers.get('apikey') ?? ''
  if (!actualAnonKey) {
    return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Unauthorized diagnostics request: missing apikey header' }, 401)
  }
  if (expectedAnonKey && !secureEqual(actualAnonKey, expectedAnonKey)) {
    return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Unauthorized diagnostics request: apikey mismatch' }, 401)
  }
  return null
}

async function readRecipient(ctx: any, studentId: string) {
  const { data, error } = await ctx.supabaseAdmin
    .from('telegram_recipients')
    .select('chat_id, enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (error) return { ok: false, error: error.message, recipient: null }
  if (!data) return { ok: false, error: 'Telegram recipient is not connected', recipient: null }
  if (!data.enabled) return { ok: false, error: 'Telegram recipient is disabled', recipient: data }
  return { ok: true, error: null, recipient: data }
}

async function cleanupOldDiagnosticProbes(ctx: any, studentId: string): Promise<number> {
  const { data, error } = await ctx.supabaseAdmin
    .from('homework_progress')
    .select('lesson_id')
    .eq('student_id', studentId)
    .like('lesson_id', '__diagnostic_probe__%')
    .limit(100)

  if (error || !Array.isArray(data) || !data.length) return 0

  const lessonIds = data.map((item: any) => item.lesson_id).filter(Boolean)
  if (!lessonIds.length) return 0

  const { error: deleteError } = await ctx.supabaseAdmin
    .from('homework_progress')
    .delete()
    .eq('student_id', studentId)
    .in('lesson_id', lessonIds)

  if (deleteError) return 0
  return lessonIds.length
}

async function handleDiagnostics(req: Request, ctx: any, payload: any): Promise<Response> {
  const studentId = normalizeStudentId(payload.studentId)
  const unauthorized = authorizeDiagnostics(req, studentId)
  if (unauthorized) return unauthorized

  if (payload.kind === 'diagnostics_health') {
    const removedProbes = await cleanupOldDiagnosticProbes(ctx, studentId)
    const { data: homeworkRows, error: homeworkError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .select('lesson_id,status,checked_at,submitted_at,score_correct,score_total,updated_at')
      .eq('student_id', studentId)
      .limit(100)

    const database: Record<string, unknown> = homeworkError
      ? { ok: false, error: homeworkError.message, homeworkRows: 0, suspiciousHomework: [] }
      : {
          ok: true,
          homeworkRows: Array.isArray(homeworkRows) ? homeworkRows.length : 0,
          suspiciousHomework: (homeworkRows || [])
            .filter((row: any) => (row.status === 'submitted' && !row.submitted_at) || (row.status === 'checked' && row.submitted_at))
            .map((row: any) => row.lesson_id),
          removedProbes,
        }

    const recipientResult = await readRecipient(ctx, studentId)
    const recipient = recipientResult.ok
      ? {
          ok: true,
          enabled: Boolean(recipientResult.recipient.enabled),
          source: 'telegram_recipients',
          threadId: null,
        }
      : {
          ok: false,
          enabled: false,
          source: 'telegram_recipients',
          threadId: null,
          error: recipientResult.error,
        }

    const telegram: Record<string, unknown> = {
      bot: { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' },
      chat: { ok: false, error: 'Recipient is not available' },
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    if (botToken) {
      try {
        const bot = await telegramRequest(botToken, 'getMe')
        telegram.bot = { ok: true, username: bot?.username || null, id: bot?.id || null }
      } catch (error) {
        telegram.bot = { ok: false, error: error instanceof Error ? error.message : String(error) }
      }

      if (recipientResult.ok) {
        try {
          const chat = await telegramRequest(botToken, 'getChat', { chat_id: Number(recipientResult.recipient.chat_id) })
          telegram.chat = { ok: true, type: chat?.type || null, title: chat?.title || chat?.first_name || null }
        } catch (error) {
          telegram.chat = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    }

    return json({
      ok: true,
      diagnosticVersion: DIAGNOSTIC_VERSION,
      studentId,
      database,
      recipient,
      telegram,
    })
  }

  if (payload.kind === 'diagnostics_cleanup_probe') {
    const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
    if (!lessonId.startsWith('__diagnostic_probe__')) {
      return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Invalid diagnostic lesson id' }, 400)
    }

    const { error } = await ctx.supabaseAdmin
      .from('homework_progress')
      .delete()
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)

    if (error) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: error.message }, 500)
    return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, cleaned: true })
  }

  if (payload.kind === 'diagnostics_homework_probe') {
    const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
    if (!lessonId.startsWith('__diagnostic_probe__')) {
      return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Invalid diagnostic lesson id' }, 400)
    }

    const stages: string[] = []
    const { data: row, error: readError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .select('id,lesson_id,status,checked_at,submitted_at')
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
      .maybeSingle()

    if (readError) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: readError.message, stages }, 500)
    if (!row) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Diagnostic row was not inserted by browser/RLS', stages }, 404)
    stages.push('server_read_checked')

    const now = new Date().toISOString()
    const { error: updateError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .update({ status: 'submitted', submitted_at: now, checked_at: row.checked_at || now })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)

    if (updateError) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: updateError.message, stages }, 500)
    stages.push('server_update_submitted')

    const { error: deleteError } = await ctx.supabaseAdmin
      .from('homework_progress')
      .delete()
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)

    if (deleteError) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: deleteError.message, stages }, 500)
    stages.push('server_cleanup')

    return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, stages })
  }

  if (payload.kind === 'diagnostics_send_report') {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    if (!botToken) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)

    const recipientResult = await readRecipient(ctx, studentId)
    if (!recipientResult.ok) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: recipientResult.error || 'Recipient is not available' }, 404)

    const { data: recent } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('created_at,sent_at')
      .eq('student_id', studentId)
      .eq('material_type', 'diagnostics_test')
      .order('created_at', { ascending: false })
      .limit(1)

    const lastSentAt = Array.isArray(recent) && recent[0] ? Date.parse(recent[0].sent_at || recent[0].created_at) : 0
    const elapsedSeconds = lastSentAt ? Math.floor((Date.now() - lastSentAt) / 1000) : 999
    if (elapsedSeconds < 30) {
      return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, skipped: true, retryAfterSeconds: 30 - elapsedSeconds })
    }

    const pageUrl = isHttpUrl(payload.pageUrl) ? payload.pageUrl : ''
    const message = [
      '🧪 <b>Тест диагностики Milena English Space</b>',
      '',
      `student_id: <code>${escapeHtml(studentId)}</code>`,
      `time: <code>${escapeHtml(new Date().toISOString())}</code>`,
      pageUrl ? `page: ${escapeHtml(pageUrl)}` : '',
    ].filter(Boolean).join('\n')

    try {
      const telegramMessage = await sendTelegramMessage(botToken, Number(recipientResult.recipient.chat_id), message, [], null)
      await ctx.supabaseAdmin
        .from('material_publications')
        .insert({
          student_id: studentId,
          material_type: 'diagnostics_test',
          material_id: `telegram-test-${Date.now()}`,
          notification_version: 1,
          status: 'sent',
          payload: { pageUrl, diagnosticVersion: DIAGNOSTIC_VERSION },
          telegram_message_id: telegramMessage.message_id,
          sent_at: new Date().toISOString(),
        })

      return json({
        ok: true,
        diagnosticVersion: DIAGNOSTIC_VERSION,
        skipped: false,
        telegramMessageId: telegramMessage.message_id,
        threadId: null,
      })
    } catch (error) {
      return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: error instanceof Error ? error.message : String(error) }, 502)
    }
  }

  return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Unknown diagnostics request' }, 400)
}

export default {
  fetch: withSupabase({ auth: 'none' }, async (req, ctx) => {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }

    if (req.method !== 'POST') {
      return json({ ok: false, error: 'Method not allowed' }, 405)
    }

    let payload: any
    try {
      payload = await req.json()
    } catch {
      return json({ ok: false, error: 'Invalid JSON' }, 400)
    }

    if (isDiagnosticsPayload(payload)) {
      return handleDiagnostics(req, ctx, payload)
    }

    const expectedSecret = Deno.env.get('NOTIFY_WEBHOOK_SECRET') ?? ''
    const actualSecret = req.headers.get('x-notify-secret') ?? ''
    if (!expectedSecret || !secureEqual(actualSecret, expectedSecret)) {
      return json({ ok: false, error: 'Unauthorized' }, 401)
    }

    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
    if (!botToken) {
      return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)
    }

    const studentId = typeof payload.studentId === 'string' ? payload.studentId.trim() : ''
    const materialType = typeof payload.materialType === 'string' ? payload.materialType.trim() : ''
    const materialId = typeof payload.materialId === 'string' ? payload.materialId.trim() : ''
    const notificationVersion = Number(payload.notificationVersion)
    const homework = payload.homework
    const vocabulary = payload.vocabulary
    const grammar = Array.isArray(payload.grammar) ? payload.grammar : []

    if (!studentId || !materialType || !materialId || !Number.isInteger(notificationVersion) || notificationVersion < 1) {
      return json({ ok: false, error: 'Missing or invalid notification identity' }, 400)
    }

    if (!homework || !isHttpUrl(homework.url)) {
      return json({ ok: false, error: 'A valid homework URL is required' }, 400)
    }

    if (vocabulary && !isHttpUrl(vocabulary.url)) {
      return json({ ok: false, error: 'Invalid vocabulary URL' }, 400)
    }

    for (const item of grammar) {
      if (!item || !isHttpUrl(item.url)) {
        return json({ ok: false, error: 'Invalid grammar URL' }, 400)
      }
    }

    const { data: recipient, error: recipientError } = await ctx.supabaseAdmin
      .from('telegram_recipients')
      .select('chat_id, enabled')
      .eq('student_id', studentId)
      .maybeSingle()

    if (recipientError) {
      return json({ ok: false, error: recipientError.message }, 500)
    }
    if (!recipient || !recipient.enabled) {
      return json(
        { ok: false, error: 'Telegram recipient is not connected or is disabled' },
        404,
      )
    }

    const { data: existing, error: existingError } = await ctx.supabaseAdmin
      .from('material_publications')
      .select('id, status, telegram_message_id')
      .eq('student_id', studentId)
      .eq('material_type', materialType)
      .eq('material_id', materialId)
      .eq('notification_version', notificationVersion)
      .maybeSingle()

    if (existingError) {
      return json({ ok: false, error: existingError.message }, 500)
    }

    if (existing?.status === 'sent') {
      return json({
        ok: true,
        skipped: true,
        reason: 'already_sent',
        telegramMessageId: existing.telegram_message_id,
      })
    }

    let publicationId = existing?.id as string | undefined

    if (publicationId) {
      const { error } = await ctx.supabaseAdmin
        .from('material_publications')
        .update({
          status: 'pending',
          payload,
          error_message: null,
        })
        .eq('id', publicationId)

      if (error) {
        return json({ ok: false, error: error.message }, 500)
      }
    } else {
      const { data: created, error } = await ctx.supabaseAdmin
        .from('material_publications')
        .insert({
          student_id: studentId,
          material_type: materialType,
          material_id: materialId,
          notification_version: notificationVersion,
          status: 'pending',
          payload,
        })
        .select('id')
        .single()

      if (error) {
        if (error.code === '23505') {
          return json({ ok: true, skipped: true, reason: 'already_claimed' })
        }
        return json({ ok: false, error: error.message }, 500)
      }
      publicationId = created.id
    }

    const keyboard: Array<Array<{ text: string; url: string }>> = []
    if (vocabulary) {
      keyboard.push([{ text: '💥 Открыть словарь', url: vocabulary.url }])
    }
    keyboard.push([{ text: '📝 Открыть домашнее задание', url: homework.url }])

    grammar.forEach((item: any, index: number) => {
      const label = grammar.length === 1
        ? '📐 Повторить грамматику'
        : `📐 ${String(item.title || `Грамматика ${index + 1}`).slice(0, 48)}`
      keyboard.push([{ text: label, url: item.url }])
    })

    try {
      const telegramMessage = await sendTelegramMessage(
        botToken,
        Number(recipient.chat_id),
        buildMessage(Boolean(vocabulary)),
        keyboard,
      )

      const { error: updateError } = await ctx.supabaseAdmin
        .from('material_publications')
        .update({
          status: 'sent',
          telegram_message_id: telegramMessage.message_id,
          sent_at: new Date().toISOString(),
          error_message: null,
        })
        .eq('id', publicationId)

      if (updateError) {
        throw new Error(`Telegram sent, but log update failed: ${updateError.message}`)
      }

      return json({
        ok: true,
        skipped: false,
        telegramMessageId: telegramMessage.message_id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await ctx.supabaseAdmin
        .from('material_publications')
        .update({ status: 'failed', error_message: message })
        .eq('id', publicationId)

      return json({ ok: false, error: message }, 502)
    }
  }),
}
