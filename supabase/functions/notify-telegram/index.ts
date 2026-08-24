import { createClient } from 'npm:@supabase/supabase-js@2'

const FUNCTION_VERSION = 'notify-telegram-milena-diagnostics-v2'
const DIAGNOSTIC_VERSION = 'milena-diagnostics-v1'
const DIAGNOSTIC_STUDENT_ID = 'milena'
const encoder = new TextEncoder()

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notify-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json({ ...body, functionVersion: FUNCTION_VERSION }, { status, headers: corsHeaders })
}

function secureEqual(left: string, right: string): boolean {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index]
  return difference === 0
}

function normalizeStudentId(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error')
  return message
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot[hidden]')
    .replace(/eyJ[A-Za-z0-9._-]+/g, '[hidden key]')
    .slice(0, 500)
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
  } catch {
    return false
  }
}

function publicHttpUrl(value: unknown): string | null {
  if (!isHttpUrl(value)) return null
  return new URL(value).toString()
}

type Recipient = {
  chat_id: number
  message_thread_id: number | null
  enabled: boolean
}

async function getRecipient(admin: any, studentId: string): Promise<Recipient> {
  const { data, error } = await admin
    .from('telegram_recipients')
    .select('chat_id,message_thread_id,enabled')
    .eq('student_id', studentId)
    .maybeSingle()

  if (error) throw error
  if (!data || !data.enabled) throw new Error('Получатель Telegram не подключён или отключён')
  return data as Recipient
}

async function telegramRequest(token: string, method: string, payload: Record<string, unknown> = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) throw new Error(result?.description || `Telegram HTTP ${response.status}`)
  return result.result
}

async function sendTelegram(
  token: string,
  recipient: Recipient,
  text: string,
  keyboard: Array<Array<{ text: string; url: string }>> = [],
) {
  const payload: Record<string, unknown> = {
    chat_id: recipient.chat_id,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }
  if (recipient.message_thread_id !== null && Number.isFinite(Number(recipient.message_thread_id))) {
    payload.message_thread_id = Number(recipient.message_thread_id)
  }
  if (keyboard.length) payload.reply_markup = { inline_keyboard: keyboard }
  return telegramRequest(token, 'sendMessage', payload)
}

function lessonTitle(lessonId: string): string {
  if (lessonId.startsWith('telegram-report-test-')) return 'ТЕСТ: проверка Telegram-отчёта'
  const match = lessonId.match(/^lesson-(\d+)$/)
  return match ? `Домашняя работа №${match[1]}` : lessonId
}

function homeworkMessage(row: Record<string, any>, displayTitle: string): string {
  const correct = Number(row.score_correct || 0)
  const total = Number(row.score_total || 0)
  const percent = Number(row.score_percent ?? (total > 0 ? Math.round((correct / total) * 100) : 0))
  return [
    '✅ <b>Homework completed</b>',
    '',
    `📘 <b>${escapeHtml(displayTitle)}</b>`,
    `📊 Result: <b>${correct}/${total} (${percent}%)</b>`,
    '',
    'Open it on the site to see the answers and mistakes.',
  ].join('\n')
}

async function homeworkDisplayTitle(admin: any, studentId: string, lessonId: string, requestedTitle = '', requestedSubtitle = ''): Promise<string> {
  const fallback = requestedTitle.trim()
    ? (requestedSubtitle.trim() ? `${requestedTitle.trim()} · ${requestedSubtitle.trim()}` : requestedTitle.trim())
    : lessonTitle(lessonId)

  const { data, error } = await admin
    .from('material_publications')
    .select('payload')
    .eq('student_id', studentId)
    .eq('material_type', 'lesson_bundle')
    .eq('material_id', lessonId)
    .order('created_at', { ascending: false })
    .limit(1)

  if (error || !data?.length) return fallback
  const stored = data[0]?.payload && typeof data[0].payload === 'object' ? data[0].payload as Record<string, any> : {}
  const homework = stored.homework && typeof stored.homework === 'object' ? stored.homework as Record<string, any> : stored
  const title = String(homework.title || '').trim()
  const subtitle = String(homework.subtitle || '').trim()
  if (!title) return fallback
  return subtitle ? `${title} · ${subtitle}` : title
}

async function handleHomeworkReport(payload: Record<string, unknown>, admin: any, botToken: string) {
  const studentId = normalizeStudentId(payload.studentId)
  const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
  const submissionId = typeof payload.submissionId === 'string' ? payload.submissionId.trim() : ''
  const requestedTitle = typeof payload.homeworkTitle === 'string' ? payload.homeworkTitle.trim() : ''
  const requestedSubtitle = typeof payload.homeworkSubtitle === 'string' ? payload.homeworkSubtitle.trim() : ''

  if (!studentId || !lessonId || !submissionId) return json({ ok: false, error: 'Некорректные параметры отчёта' }, 400)

  const { data: row, error } = await admin
    .from('homework_progress')
    .select('submission_id,student_id,lesson_id,status,score_correct,score_total,score_percent,submitted_at,locked_at,report_status,report_sent_at')
    .eq('student_id', studentId)
    .eq('lesson_id', lessonId)
    .eq('submission_id', submissionId)
    .maybeSingle()

  if (error) return json({ ok: false, error: safeError(error) }, 500)
  if (!row) return json({ ok: false, error: 'Зафиксированная домашняя работа не найдена' }, 404)
  if (!['submitted_pending_report', 'submitted'].includes(row.status)) {
    return json({ ok: false, error: 'Домашняя работа ещё не зафиксирована' }, 409)
  }
  if (row.status === 'submitted' && row.report_status === 'sent') {
    return json({ ok: true, skipped: true, reason: 'already_sent', reportSentAt: row.report_sent_at })
  }

  let recipient: Recipient
  try {
    recipient = await getRecipient(admin, studentId)
  } catch (recipientError) {
    const message = safeError(recipientError)
    await admin.from('homework_progress').update({ report_status: 'failed', report_error: message }).eq('submission_id', submissionId)
    return json({ ok: false, error: message }, 404)
  }

  try {
    const siteBaseUrl = (Deno.env.get('SITE_BASE_URL') || '').replace(/\/+$/, '')
    const lessonUrl = siteBaseUrl ? `${siteBaseUrl}/lesson.html?id=${encodeURIComponent(lessonId)}` : ''
    const keyboard = lessonUrl ? [[{ text: '📝 Open the homework', url: lessonUrl }]] : []
    const displayTitle = await homeworkDisplayTitle(admin, studentId, lessonId, requestedTitle, requestedSubtitle)
    const telegramMessage = await sendTelegram(botToken, recipient, homeworkMessage(row, displayTitle), keyboard)
    const sentAt = new Date().toISOString()
    const { error: updateError } = await admin
      .from('homework_progress')
      .update({ status: 'submitted', report_status: 'sent', report_sent_at: sentAt, report_error: null })
      .eq('submission_id', submissionId)
    if (updateError) throw new Error(`Telegram отправлен, но статус не обновлён: ${updateError.message}`)
    return json({ ok: true, skipped: false, telegramMessageId: telegramMessage.message_id, reportSentAt: sentAt })
  } catch (sendError) {
    const message = safeError(sendError)
    await admin.from('homework_progress').update({ report_status: 'failed', report_error: message }).eq('submission_id', submissionId)
    return json({ ok: false, error: message }, 502)
  }
}

async function claimLessonPublication(admin: any, record: { student_id: string; material_type: string; material_id: string; notification_version: number; payload: Record<string, unknown> }) {
  const { data: existingRows, error: lookupError } = await admin
    .from('material_publications')
    .select('*')
    .eq('student_id', record.student_id)
    .eq('material_type', record.material_type)
    .eq('material_id', record.material_id)
    .eq('notification_version', record.notification_version)
    .order('created_at', { ascending: true })
    .limit(1)

  if (lookupError) throw lookupError
  const existing = existingRows?.[0]
  if (existing?.status === 'sent') return { row: existing, alreadySent: true }

  if (existing) {
    const { data, error } = await admin
      .from('material_publications')
      .update({ status: 'pending', payload: record.payload, error_message: null })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) throw error
    return { row: data, alreadySent: false }
  }

  const { data, error } = await admin
    .from('material_publications')
    .insert({ ...record, status: 'pending' })
    .select()
    .single()
  if (error) throw error
  return { row: data, alreadySent: false }
}

function grammarButtonTitle(item: Record<string, unknown>, index: number): string {
  const fullTitle = String(item.title || `Grammar ${index + 1}`).trim()
  const shortTitle = fullTitle.split(':')[0].trim()
  return shortTitle.length > 0 && shortTitle.length <= 34 ? shortTitle : `Grammar ${index + 1}`
}

function homeworkGreeting(materialId: string): string {
  const greetings = ['Hi! ✨', 'Hello! 🌟', 'Hey! 👋', 'Hi there! ☀️', 'Hello there! ✨']
  let hash = 0
  for (const char of materialId) hash = ((hash * 31) + char.codePointAt(0)!) >>> 0
  return greetings[hash % greetings.length]
}

async function handleMaterialPublished(payload: Record<string, any>, request: Request, admin: any, botToken: string) {
  const expectedSecret = Deno.env.get('NOTIFY_WEBHOOK_SECRET') || ''
  const actualSecret = request.headers.get('x-notify-secret') || ''
  if (!expectedSecret || !secureEqual(actualSecret, expectedSecret)) return json({ ok: false, error: 'Unauthorized' }, 401)

  const studentId = normalizeStudentId(payload.studentId)
  const materialType = String(payload.materialType || 'lesson_bundle').trim()
  const materialId = String(payload.materialId || '').trim()
  const notificationVersion = Number.isInteger(Number(payload.notificationVersion)) && Number(payload.notificationVersion) > 0
    ? Number(payload.notificationVersion)
    : 1

  if (!studentId || materialType !== 'lesson_bundle' || !materialId) {
    return json({ ok: false, error: 'Некорректные параметры публикации урока' }, 400)
  }

  const legacyPayload = payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload)
    ? payload.payload as Record<string, unknown>
    : {}
  const rawHomework = payload.homework && typeof payload.homework === 'object' && !Array.isArray(payload.homework)
    ? payload.homework as Record<string, unknown>
    : { id: materialId, title: legacyPayload.title || materialId, subtitle: legacyPayload.subtitle || '', url: legacyPayload.url || '' }
  const homeworkUrl = publicHttpUrl(rawHomework.url)
  if (!homeworkUrl) return json({ ok: false, error: 'A valid homework URL is required' }, 400)

  const rawVocabulary = payload.vocabulary && typeof payload.vocabulary === 'object' && !Array.isArray(payload.vocabulary)
    ? payload.vocabulary as Record<string, unknown>
    : null
  const vocabularyUrl = rawVocabulary ? publicHttpUrl(rawVocabulary.url) : null
  if (rawVocabulary && !vocabularyUrl) return json({ ok: false, error: 'Invalid vocabulary URL' }, 400)

  const rawGrammar = Array.isArray(payload.grammar) ? payload.grammar : []
  const grammar: Record<string, unknown>[] = []
  for (const item of rawGrammar) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return json({ ok: false, error: 'Invalid grammar URL' }, 400)
    const topic = item as Record<string, unknown>
    const url = publicHttpUrl(topic.url)
    if (!url) return json({ ok: false, error: 'Invalid grammar URL' }, 400)
    grammar.push({ ...topic, url })
  }

  const storedPayload = {
    homework: { ...rawHomework, url: homeworkUrl },
    vocabulary: rawVocabulary ? { ...rawVocabulary, url: vocabularyUrl } : null,
    grammar,
  }

  let claim
  try {
    claim = await claimLessonPublication(admin, {
      student_id: studentId,
      material_type: materialType,
      material_id: materialId,
      notification_version: notificationVersion,
      payload: storedPayload,
    })
  } catch (claimError) {
    return json({ ok: false, error: safeError(claimError) }, 500)
  }
  if (claim.alreadySent) return json({ ok: true, skipped: true, alreadySent: true, reason: 'already_sent' })

  try {
    const recipient = await getRecipient(admin, studentId)
    const title = String(rawHomework.title || legacyPayload.title || materialId)
    const steps: string[] = []
    if (rawVocabulary) steps.push('First, learn the new words.')
    if (grammar.length) steps.push(rawVocabulary ? 'Review the grammar.' : 'First, review the grammar.')
    steps.push(steps.length ? 'Then, do the homework.' : 'Do the homework.')

    const text = [
      homeworkGreeting(materialId),
      'Your new English homework is ready.',
      `📘 <b>${escapeHtml(title)}</b>`,
      steps.join('\n'),
      'Good luck! ⭐',
    ].join('\n\n')

    const keyboard: Array<Array<{ text: string; url: string }>> = []
    if (rawVocabulary && vocabularyUrl) keyboard.push([{ text: '📚 Learn new words', url: vocabularyUrl }])
    grammar.forEach((item, index) => {
      keyboard.push([{ text: grammar.length === 1 ? '📘 Grammar' : `📘 ${grammarButtonTitle(item, index)}`, url: String(item.url) }])
    })
    keyboard.push([{ text: '📝 Do the homework', url: homeworkUrl }])

    const telegramMessage = await sendTelegram(botToken, recipient, text, keyboard)
    const sentAt = new Date().toISOString()
    const { error: updateError } = await admin
      .from('material_publications')
      .update({ status: 'sent', telegram_message_id: telegramMessage.message_id || null, sent_at: sentAt, error_message: null })
      .eq('id', claim.row.id)
    if (updateError) throw updateError
    return json({ ok: true, skipped: false, telegramMessageId: telegramMessage.message_id || null, sentAt })
  } catch (sendError) {
    const message = safeError(sendError)
    await admin.from('material_publications').update({ status: 'failed', error_message: message }).eq('id', claim.row.id)
    return json({ ok: false, error: message }, 502)
  }
}

function isDiagnosticsPayload(payload: Record<string, any>): boolean {
  return typeof payload.kind === 'string' && payload.kind.startsWith('diagnostics_')
}

function authorizeDiagnostics(request: Request, studentId: string): Response | null {
  if (studentId !== DIAGNOSTIC_STUDENT_ID) {
    return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Diagnostics are not allowed for this student_id' }, 403)
  }
  const expectedAnonKey = Deno.env.get('SUPABASE_ANON_KEY') || ''
  const actualAnonKey = request.headers.get('apikey') || ''
  if (!actualAnonKey) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Unauthorized diagnostics request: missing apikey header' }, 401)
  if (expectedAnonKey && !secureEqual(actualAnonKey, expectedAnonKey)) {
    return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Unauthorized diagnostics request: apikey mismatch' }, 401)
  }
  return null
}

async function cleanupOldDiagnosticProbes(admin: any, studentId: string): Promise<number> {
  const { data, error } = await admin
    .from('homework_progress')
    .select('lesson_id')
    .eq('student_id', studentId)
    .like('lesson_id', '__diagnostic_probe__%')
    .limit(100)
  if (error || !Array.isArray(data) || !data.length) return 0
  const ids = data.map((item: any) => item.lesson_id).filter(Boolean)
  if (!ids.length) return 0
  const { error: deleteError } = await admin.from('homework_progress').delete().eq('student_id', studentId).in('lesson_id', ids)
  return deleteError ? 0 : ids.length
}

async function handleDiagnostics(request: Request, admin: any, payload: Record<string, any>, botToken: string) {
  const studentId = normalizeStudentId(payload.studentId)
  const unauthorized = authorizeDiagnostics(request, studentId)
  if (unauthorized) return unauthorized

  if (payload.kind === 'diagnostics_health') {
    const removedProbes = await cleanupOldDiagnosticProbes(admin, studentId)
    const { data: homeworkRows, error: homeworkError } = await admin
      .from('homework_progress')
      .select('lesson_id,status,checked_at,submitted_at,score_correct,score_total,updated_at')
      .eq('student_id', studentId)
      .limit(100)

    const database = homeworkError
      ? { ok: false, error: homeworkError.message, homeworkRows: 0, suspiciousHomework: [], removedProbes }
      : {
          ok: true,
          homeworkRows: Array.isArray(homeworkRows) ? homeworkRows.length : 0,
          suspiciousHomework: (homeworkRows || [])
            .filter((row: any) => (row.status === 'submitted' && !row.submitted_at) || (row.status === 'checked' && row.submitted_at))
            .map((row: any) => row.lesson_id),
          removedProbes,
        }

    let recipient: Record<string, unknown>
    let recipientRow: Recipient | null = null
    try {
      recipientRow = await getRecipient(admin, studentId)
      recipient = { ok: true, enabled: Boolean(recipientRow.enabled), source: 'telegram_recipients', threadId: recipientRow.message_thread_id ?? null }
    } catch (error) {
      recipient = { ok: false, enabled: false, source: 'telegram_recipients', threadId: null, error: safeError(error) }
    }

    const telegram: Record<string, unknown> = {
      bot: { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' },
      chat: { ok: false, error: 'Recipient is not available' },
    }
    if (botToken) {
      try {
        const bot = await telegramRequest(botToken, 'getMe')
        telegram.bot = { ok: true, username: bot?.username || null, id: bot?.id || null }
      } catch (error) {
        telegram.bot = { ok: false, error: safeError(error) }
      }
      if (recipientRow) {
        try {
          const chat = await telegramRequest(botToken, 'getChat', { chat_id: Number(recipientRow.chat_id) })
          telegram.chat = { ok: true, type: chat?.type || null, title: chat?.title || chat?.first_name || null }
        } catch (error) {
          telegram.chat = { ok: false, error: safeError(error) }
        }
      }
    }

    return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, studentId, database, recipient, telegram })
  }

  if (payload.kind === 'diagnostics_cleanup_probe') {
    const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
    if (!lessonId.startsWith('__diagnostic_probe__')) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Invalid diagnostic lesson id' }, 400)
    const { error } = await admin.from('homework_progress').delete().eq('student_id', studentId).eq('lesson_id', lessonId)
    if (error) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: error.message }, 500)
    return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, cleaned: true })
  }

  if (payload.kind === 'diagnostics_homework_probe') {
    const lessonId = typeof payload.lessonId === 'string' ? payload.lessonId.trim() : ''
    if (!lessonId.startsWith('__diagnostic_probe__')) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Invalid diagnostic lesson id' }, 400)
    const stages: string[] = []
    const { data: row, error: readError } = await admin
      .from('homework_progress')
      .select('lesson_id,status,checked_at,submitted_at')
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
      .maybeSingle()
    if (readError) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: readError.message, stages }, 500)
    if (!row) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Diagnostic row was not inserted by browser/RLS', stages }, 404)
    stages.push('server_read')

    const now = new Date().toISOString()
    const { error: updateError } = await admin
      .from('homework_progress')
      .update({
        status: 'submitted',
        checked_at: row.checked_at || now,
        submitted_at: row.submitted_at || now,
        locked_at: now,
        report_status: 'sent',
        report_sent_at: now,
        report_error: null,
      })
      .eq('student_id', studentId)
      .eq('lesson_id', lessonId)
    if (updateError) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: updateError.message, stages }, 500)
    stages.push('server_update_submitted')

    const { error: deleteError } = await admin.from('homework_progress').delete().eq('student_id', studentId).eq('lesson_id', lessonId)
    if (deleteError) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: deleteError.message, stages }, 500)
    stages.push('server_cleanup')
    return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, stages })
  }

  if (payload.kind === 'diagnostics_send_report') {
    if (!botToken) return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)
    let recipient: Recipient
    try {
      recipient = await getRecipient(admin, studentId)
    } catch (error) {
      return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: safeError(error) }, 404)
    }

    const { data: recent } = await admin
      .from('material_publications')
      .select('created_at,sent_at')
      .eq('student_id', studentId)
      .eq('material_type', 'diagnostics_test')
      .order('created_at', { ascending: false })
      .limit(1)
    const lastSentAt = Array.isArray(recent) && recent[0] ? Date.parse(recent[0].sent_at || recent[0].created_at) : 0
    const elapsedSeconds = lastSentAt ? Math.floor((Date.now() - lastSentAt) / 1000) : 999
    if (elapsedSeconds < 30) return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, skipped: true, retryAfterSeconds: 30 - elapsedSeconds })

    const pageUrl = isHttpUrl(payload.pageUrl) ? payload.pageUrl : ''
    const message = [
      '🧪 <b>Тест диагностики Milena English Space</b>',
      '',
      `student_id: <code>${escapeHtml(studentId)}</code>`,
      `time: <code>${escapeHtml(new Date().toISOString())}</code>`,
      pageUrl ? `page: ${escapeHtml(pageUrl)}` : '',
    ].filter(Boolean).join('\n')

    try {
      const telegramMessage = await sendTelegram(botToken, recipient, message, [])
      await admin.from('material_publications').insert({
        student_id: studentId,
        material_type: 'diagnostics_test',
        material_id: `telegram-test-${Date.now()}`,
        notification_version: 1,
        status: 'sent',
        payload: { pageUrl, diagnosticVersion: DIAGNOSTIC_VERSION },
        telegram_message_id: telegramMessage.message_id,
        sent_at: new Date().toISOString(),
      })
      return json({ ok: true, diagnosticVersion: DIAGNOSTIC_VERSION, skipped: false, telegramMessageId: telegramMessage.message_id, threadId: recipient.message_thread_id ?? null })
    } catch (error) {
      return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: safeError(error) }, 502)
    }
  }

  return json({ ok: false, diagnosticVersion: DIAGNOSTIC_VERSION, error: 'Unknown diagnostics request' }, 400)
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405)

  const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
  if (!supabaseUrl || !serviceKey) return json({ ok: false, error: 'Серверные секреты Edge Function не настроены' }, 500)

  let payload: Record<string, any>
  try {
    payload = await request.json()
  } catch {
    return json({ ok: false, error: 'Некорректный JSON' }, 400)
  }

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  if (isDiagnosticsPayload(payload)) return handleDiagnostics(request, admin, payload, botToken)

  if (!botToken) return json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' }, 500)

  const action = String(payload.action || '')
  if (action === 'homework_report') return handleHomeworkReport(payload, admin, botToken)
  if (action === 'material_published' || (!action && payload.materialType === 'lesson_bundle')) {
    return handleMaterialPublished(payload, request, admin, botToken)
  }

  return json({ ok: false, error: 'Неизвестное действие' }, 400)
})
