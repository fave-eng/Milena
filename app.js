(() => {
  'use strict';

  const config = window.APP_CONFIG || {};
  const student = config.student || {};
  let HOMEWORK_DATA = [];
  const RAW_VOCABULARY_DATA = Array.isArray(window.VOCABULARY_DATA) ? window.VOCABULARY_DATA : [];
  const GRAMMAR_DATA = Array.isArray(window.GRAMMAR_DATA) ? window.GRAMMAR_DATA : [];
  const lessonCache = new Map();
  const lessonsPath = 'data/lessons';
  const maxLessonNumber = 200;
  const maxConsecutiveMissingLessons = 3;

  const safeText = (value, fallback = '') => value === undefined || value === null ? fallback : String(value);
  const escapeHtml = (value) => safeText(value)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const byId = (id) => document.getElementById(id);
  const queryParam = (name) => new URLSearchParams(window.location.search).get(name) || '';
  const unique = (items) => [...new Set(Array.isArray(items) ? items : [])];
  const safePercent = (value, total) => {
    const numerator = Number(value) || 0;
    const denominator = Number(total) || 0;
    if (denominator <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
  };
  const shuffled = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const dateMs = (value) => {
    const time = Date.parse(value || '');
    return Number.isFinite(time) ? time : 0;
  };

  function normalizeLesson(rawLesson, requestedId = '') {
    if (!rawLesson || typeof rawLesson !== 'object') return null;
    const id = safeText(rawLesson.id || requestedId).trim();
    if (!/^lesson-\d+$/.test(id)) return null;
    const inferredNumber = Number(id.replace('lesson-', '')) || 0;
    return {
      ...rawLesson,
      id,
      // The homework number is always derived from the lesson-N.json file name.
      // This keeps homework numbering sequential when vocabulary or grammar materials are added.
      number: inferredNumber,
      title: safeText(rawLesson.title, `Lesson ${inferredNumber}`),
      subtitle: safeText(rawLesson.subtitle, 'Интерактивное домашнее задание'),
      status: safeText(rawLesson.status, 'available'),
      page: `lesson.html?id=${encodeURIComponent(id)}`,
      blocks: Array.isArray(rawLesson.blocks) ? rawLesson.blocks : []
    };
  }

  async function fetchLessonFile(id) {
    const cleanId = safeText(id).trim();
    if (!/^lesson-\d+$/.test(cleanId)) return null;
    if (lessonCache.has(cleanId)) return lessonCache.get(cleanId);

    const promise = (async () => {
      const url = new URL(`${lessonsPath}/${cleanId}.json`, document.baseURI);
      const response = await fetch(url, { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Could not load ${cleanId}.json: ${response.status}`);
      const lesson = normalizeLesson(await response.json(), cleanId);
      if (!lesson) throw new Error(`File ${cleanId}.json has an invalid structure.`);
      return lesson;
    })();

    lessonCache.set(cleanId, promise);
    try {
      return await promise;
    } catch (error) {
      lessonCache.delete(cleanId);
      throw error;
    }
  }

  async function discoverHomeworkData() {
    const lessons = [];
    let consecutiveMissing = 0;

    for (let number = 1; number <= maxLessonNumber; number += 1) {
      const lesson = await fetchLessonFile(`lesson-${number}`);
      if (lesson) {
        lessons.push(lesson);
        consecutiveMissing = 0;
      } else {
        consecutiveMissing += 1;
        if (consecutiveMissing >= maxConsecutiveMissingLessons) break;
      }
    }

    return lessons.sort((a, b) => Number(a.number || 0) - Number(b.number || 0));
  }

  async function loadHomeworkData() {
    const view = document.body?.dataset?.view || '';
    const requestedId = queryParam('id');

    if (view === 'lesson' && requestedId) {
      const lesson = await fetchLessonFile(requestedId);
      HOMEWORK_DATA = lesson ? [lesson] : [];
    } else {
      HOMEWORK_DATA = await discoverHomeworkData();
    }

    window.HOMEWORK_DATA = HOMEWORK_DATA;
    return HOMEWORK_DATA;
  }

  async function resolveLessonContent(lesson) {
    return lesson || null;
  }

  function normalizeWordKey(value) {
    return safeText(value)
      .normalize('NFKC')
      .toLocaleLowerCase('en')
      .replace(/[’‘`]/g, "'")
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/^[\s.,!?;:()[\]{}"“”]+|[\s.,!?;:()[\]{}"“”]+$/g, '');
  }

  function buildVocabularyCatalog(topics) {
    const seen = new Map();
    const byKey = new Map();
    const idToKey = new Map();
    const duplicates = [];
    const preparedTopics = topics.map((topic) => {
      const words = [];
      (Array.isArray(topic.words) ? topic.words : []).forEach((sourceWord) => {
        const wordKey = normalizeWordKey(sourceWord.uniqueKey || sourceWord.en);
        if (!wordKey) return;
        idToKey.set(safeText(sourceWord.id), wordKey);
        if (seen.has(wordKey)) {
          duplicates.push({ wordKey, skippedTopicId: topic.id, firstTopicId: seen.get(wordKey).topicId });
          return;
        }
        const word = { ...sourceWord, __wordKey: wordKey };
        const record = { word, topicId: topic.id };
        seen.set(wordKey, record);
        byKey.set(wordKey, record);
        words.push(word);
      });
      return { ...topic, words };
    });
    if (duplicates.length) {
      console.info('Duplicate words were excluded from the vocabulary:', duplicates);
    }
    return {
      topics: preparedTopics.filter((topic) => topic.words.length > 0),
      allTopics: preparedTopics,
      allWords: [...byKey.values()].map((item) => item.word),
      byKey,
      idToKey,
      duplicates
    };
  }

  const VOCABULARY_CATALOG = buildVocabularyCatalog(RAW_VOCABULARY_DATA);
  const VOCABULARY_DATA = VOCABULARY_CATALOG.topics;

  function showToast(message) {
    const toast = byId('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3000);
  }

  const storage = {
    read(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch (error) {
        console.warn('Could not read local progress:', error);
        return fallback;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (error) {
        console.warn('Could not save local progress:', error);
        return false;
      }
    }
  };

  const studentId = safeText(student.id, 'student').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'student';
  const key = (section) => `english_space_${studentId}_${section}`;
  const tables = {
    homework: config.supabase?.tables?.homework || 'homework_progress',
    vocabulary: config.supabase?.tables?.vocabulary || 'vocabulary_progress',
    vocabularyTopics: config.supabase?.tables?.vocabularyTopics || 'vocabulary_topic_progress',
    grammar: config.supabase?.tables?.grammar || 'grammar_progress'
  };

  const CloudService = {
    client: null,
    syncing: false,
    timers: {},
    isConfigured() {
      return Boolean(
        config.features?.cloudSync &&
        safeText(config.supabase?.url).trim() &&
        safeText(config.supabase?.anonKey).trim() &&
        window.supabase?.createClient
      );
    },
    async init() {
      if (!this.isConfigured()) return null;
      if (!this.client) {
        // Remove the stored session from the previous site version.
        // Otherwise Supabase may send requests as authenticated,
        // although the current setup expects the anon role.
        try {
          const projectRef = new URL(config.supabase.url).hostname.split('.')[0];
          window.localStorage.removeItem(`sb-${projectRef}-auth-token`);
        } catch (error) {
          console.warn('Could not clear the old Supabase session:', error);
        }

        const emptyAuthStorage = {
          getItem() { return null; },
          setItem() {},
          removeItem() {}
        };

        this.client = window.supabase.createClient(
          config.supabase.url,
          config.supabase.anonKey,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false,
              storage: emptyAuthStorage
            }
          }
        );
      }
      return this.client;
    },
    queue(section) {
      if (!this.isConfigured() || !this.client || this.syncing) return;
      window.clearTimeout(this.timers[section]);
      this.timers[section] = window.setTimeout(() => {
        window.ProgressService.syncToCloud(section).catch((error) => {
          console.error('Cloud save error:', error);
          showToast('Не удалось сохранить прогресс в Supabase');
        });
      }, 450);
    }
  };

  function normalizeVocabularyProgress(value) {
    const words = value?.words && typeof value.words === 'object' ? { ...value.words } : {};
    const topics = {};
    Object.entries(value?.topics && typeof value.topics === 'object' ? value.topics : {}).forEach(([topicId, topic]) => {
      topics[topicId] = { tests: Array.isArray(topic?.tests) ? topic.tests : [] };
      unique(topic?.known).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey) words[wordKey] = { status: 'known', topicId, learnedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      });
      unique(topic?.difficult).forEach((legacyId) => {
        const wordKey = VOCABULARY_CATALOG.idToKey.get(safeText(legacyId));
        if (wordKey && words[wordKey]?.status !== 'known') words[wordKey] = { status: 'difficult', topicId, updatedAt: new Date().toISOString() };
      });
    });
    Object.entries(words).forEach(([wordKey, item]) => {
      if (!['known', 'difficult'].includes(item?.status)) delete words[wordKey];
    });
    return { words, topics };
  }

  window.ProgressService = {
    loadHomeworkProgress() {
      const value = storage.read(key('homework'), {});
      return {
        completedIds: unique(value.completedIds),
        results: value.results && typeof value.results === 'object' ? value.results : {},
        submissions: value.submissions && typeof value.submissions === 'object' ? value.submissions : {}
      };
    },
    saveHomeworkProgress(progress) {
      const ok = storage.write(key('homework'), progress || {});
      CloudService.queue('homework');
      return ok;
    },
    loadVocabularyProgress() {
      return normalizeVocabularyProgress(storage.read(key('vocabulary'), {}));
    },
    saveVocabularyProgress(progress) {
      const normalized = normalizeVocabularyProgress(progress || {});
      const ok = storage.write(key('vocabulary'), normalized);
      const difficult = Object.entries(normalized.words)
        .filter(([, item]) => item.status === 'difficult')
        .map(([wordKey]) => wordKey);
      storage.write(key('difficult_words'), difficult);
      CloudService.queue('vocabulary');
      return ok;
    },
    loadGrammarProgress() {
      const value = storage.read(key('grammar'), {});
      return { topics: value.topics && typeof value.topics === 'object' ? value.topics : {} };
    },
    saveGrammarProgress(progress) {
      const ok = storage.write(key('grammar'), progress || {});
      CloudService.queue('grammar');
      return ok;
    },
    async syncFromCloud() {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      CloudService.syncing = true;
      try {
        const client = CloudService.client;
        const [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse] = await Promise.all([
          client.from(tables.homework).select('*').eq('student_id', studentId),
          client.from(tables.vocabulary).select('*').eq('student_id', studentId),
          client.from(tables.vocabularyTopics).select('*').eq('student_id', studentId),
          client.from(tables.grammar).select('*').eq('student_id', studentId)
        ]);
        [homeworkResponse, vocabularyResponse, vocabularyTopicsResponse, grammarResponse].forEach((response) => {
          if (response.error) throw response.error;
        });

        const homework = this.loadHomeworkProgress();
        (homeworkResponse.data || []).forEach((row) => {
          const localResult = homework.results[row.lesson_id];
          if (!localResult || dateMs(row.updated_at) >= dateMs(localResult.checkedAt)) {
            homework.results[row.lesson_id] = {
              correct: Number(row.score_correct || 0),
              total: Number(row.score_total || 0),
              percent: Number(row.score_percent || 0),
              answers: row.answers && typeof row.answers === 'object' ? row.answers : {},
              checkedAt: row.checked_at || row.updated_at
            };
          }
          if (row.status === 'submitted') {
            homework.submissions[row.lesson_id] = { savedAt: row.submitted_at || row.updated_at, status: 'cloud' };
            homework.completedIds.push(row.lesson_id);
          } else if (Number(row.score_total) > 0 && Number(row.score_correct) === Number(row.score_total)) {
            homework.completedIds.push(row.lesson_id);
          }
        });
        homework.completedIds = unique(homework.completedIds);
        storage.write(key('homework'), homework);

        const vocabulary = this.loadVocabularyProgress();
        (vocabularyResponse.data || []).forEach((row) => {
          const local = vocabulary.words[row.word_key];
          if (!local || dateMs(row.updated_at) >= dateMs(local.updatedAt)) {
            vocabulary.words[row.word_key] = {
              status: row.status,
              topicId: row.source_topic_id || '',
              learnedAt: row.learned_at || null,
              updatedAt: row.updated_at
            };
          }
        });
        (vocabularyTopicsResponse.data || []).forEach((row) => {
          const localTests = vocabulary.topics[row.topic_id]?.tests || [];
          const cloudTests = Array.isArray(row.tests) ? row.tests : [];
          const merged = new Map();
          [...localTests, ...cloudTests].forEach((test) => merged.set(test.completedAt || JSON.stringify(test), test));
          vocabulary.topics[row.topic_id] = { tests: [...merged.values()] };
        });
        storage.write(key('vocabulary'), normalizeVocabularyProgress(vocabulary));

        const grammar = this.loadGrammarProgress();
        (grammarResponse.data || []).forEach((row) => {
          const local = grammar.topics[row.topic_id] || {};
          grammar.topics[row.topic_id] = {
            passed: Boolean(local.passed || row.passed),
            attempts: Math.max(Number(local.attempts || 0), Number(row.attempts || 0)),
            bestScore: Math.max(Number(local.bestScore || 0), Number(row.best_score || 0)),
            updatedAt: dateMs(row.updated_at) >= dateMs(local.updatedAt) ? row.updated_at : local.updatedAt
          };
        });
        storage.write(key('grammar'), grammar);
        await this.syncToCloud();
        return true;
      } finally {
        CloudService.syncing = false;
      }
    },
    async syncToCloud(section = 'all') {
      if (!CloudService.isConfigured()) return false;
      if (!CloudService.client) await CloudService.init();
      const client = CloudService.client;
      const sections = section === 'all' ? ['homework', 'vocabulary', 'grammar'] : [section];

      if (sections.includes('homework')) {
        const progress = this.loadHomeworkProgress();
        const lessonIds = unique([...Object.keys(progress.results), ...Object.keys(progress.submissions)]);
        const rows = lessonIds.map((lessonId) => {
          const result = progress.results[lessonId] || {};
          const submission = progress.submissions[lessonId];
          const lesson = HOMEWORK_DATA.find((item) => item.id === lessonId) || {};
          const total = Number(result.total || 0);
          const correct = Number(result.correct || 0);
          return {
            student_id: studentId,
            student_name: safeText(student.nameEn || student.nameRu),
            lesson_id: lessonId,
            lesson_title: safeText(lesson.title, lessonId),
            status: submission ? 'submitted' : 'checked',
            answers: result.answers && typeof result.answers === 'object' ? result.answers : {},
            score_correct: total > 0 ? correct : null,
            score_total: total > 0 ? total : null,
            score_percent: total > 0 ? safePercent(correct, total) : null,
            checked_at: result.checkedAt || null,
            submitted_at: submission?.savedAt || null
          };
        });
        if (rows.length) {
          const { error } = await client.from(tables.homework).upsert(rows, { onConflict: 'student_id,lesson_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('vocabulary')) {
        const progress = this.loadVocabularyProgress();
        const wordRows = Object.entries(progress.words).filter(([wordKey]) => VOCABULARY_CATALOG.byKey.has(wordKey)).map(([wordKey, state]) => {
          const record = VOCABULARY_CATALOG.byKey.get(wordKey);
          return {
            student_id: studentId,
            word_key: wordKey,
            word_id: safeText(record?.word?.id, wordKey),
            en: safeText(record?.word?.en, wordKey),
            ru: safeText(record?.word?.ru),
            source_topic_id: state.topicId || record?.topicId || null,
            status: state.status,
            learned_at: state.status === 'known' ? (state.learnedAt || new Date().toISOString()) : null
          };
        });
        if (wordRows.length) {
          const { error } = await client.from(tables.vocabulary).upsert(wordRows, { onConflict: 'student_id,word_key' });
          if (error) throw error;
        }
        const topicRows = Object.entries(progress.topics)
          .filter(([, topic]) => Array.isArray(topic.tests) && topic.tests.length)
          .map(([topicId, topic]) => ({ student_id: studentId, topic_id: topicId, tests: topic.tests }));
        if (topicRows.length) {
          const { error } = await client.from(tables.vocabularyTopics).upsert(topicRows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }

      if (sections.includes('grammar')) {
        const progress = this.loadGrammarProgress();
        const rows = Object.entries(progress.topics).map(([topicId, state]) => ({
          student_id: studentId,
          topic_id: topicId,
          passed: Boolean(state.passed),
          attempts: Number(state.attempts || 0),
          best_score: Number(state.bestScore || 0)
        }));
        if (rows.length) {
          const { error } = await client.from(tables.grammar).upsert(rows, { onConflict: 'student_id,topic_id' });
          if (error) throw error;
        }
      }
      return true;
    }
  };

  function fillConfig() {
    const values = {
      nameRu: student.nameRu,
      nameEn: student.nameEn,
      level: student.level,
      textbook: student.textbook,
      textbookEdition: student.textbookEdition
    };
    document.querySelectorAll('[data-config]').forEach((node) => {
      node.textContent = safeText(values[node.dataset.config]);
    });
    if (student.nameEn) document.title = `${document.title} · ${student.nameEn}`;
  }

  function markNavigation() {
    const page = document.body.dataset.page;
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === page;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
    });
  }

  function progressMarkup(label, value, total, tone = '') {
    const percent = safePercent(value, total);
    return `<div class="progress-row">
      <div class="progress-row-head"><strong>${escapeHtml(label)}</strong><span>${Number(value) || 0} из ${Number(total) || 0}</span></div>
      <div class="progress-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">
        <div class="progress-fill ${tone}" style="width:${percent}%"></div>
      </div>
    </div>`;
  }

  function totals() {
    const hwProgress = window.ProgressService.loadHomeworkProgress();
    const vocabProgress = window.ProgressService.loadVocabularyProgress();
    const grammarProgress = window.ProgressService.loadGrammarProgress();
    const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed', 'locked'].includes(item.status));
    const completedHomework = publishedHomework.filter((item) => hwProgress.completedIds.includes(item.id) || item.status === 'completed').length;
    const knownWordKeys = Object.entries(vocabProgress.words).filter(([wordKey, item]) => VOCABULARY_CATALOG.byKey.has(wordKey) && item.status === 'known').map(([wordKey]) => wordKey);
    const passedGrammar = GRAMMAR_DATA.filter((topic) => grammarProgress.topics[topic.id]?.passed === true || topic.passed === true).length;
    return {
      homeworkTotal: publishedHomework.length,
      homeworkCompleted: completedHomework,
      vocabularyTotal: VOCABULARY_CATALOG.allWords.length,
      vocabularyKnown: knownWordKeys.length,
      vocabularyTopics: VOCABULARY_DATA.length,
      grammarTotal: GRAMMAR_DATA.filter((topic) => topic.status !== 'draft').length,
      grammarPassed: passedGrammar
    };
  }

  function emptyState(icon, title, text) {
    return `<div class="card empty-state"><div class="empty-state-icon">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div>`;
  }

  function renderHome() {
    const t = totals();
    if (byId('home-stat-completed')) byId('home-stat-completed').textContent = t.homeworkCompleted;
    if (byId('vocab-stat-known')) byId('vocab-stat-known').textContent = t.vocabularyKnown;
    if (byId('grammar-stat-passed')) byId('grammar-stat-passed').textContent = t.grammarPassed;
    const list = byId('home-progress-list');
    if (list) list.innerHTML = [
      progressMarkup('Домашние задания', t.homeworkCompleted, t.homeworkTotal),
      progressMarkup('Словарь', t.vocabularyKnown, t.vocabularyTotal, 'rose'),
      progressMarkup('Грамматика', t.grammarPassed, t.grammarTotal, 'green')
    ].join('');
    const current = byId('current-material');
    if (current) {
      const homeworkProgress = window.ProgressService.loadHomeworkProgress();
      const currentHomework = HOMEWORK_DATA
        .filter((item) => item.status === 'available' && !homeworkProgress.completedIds.includes(item.id))
        .sort((a, b) => dateMs(b.publishedAt) - dateMs(a.publishedAt) || Number(b.number || 0) - Number(a.number || 0))[0];

      if (currentHomework) {
        const href = currentHomework.page || `lesson.html?id=${encodeURIComponent(currentHomework.id)}`;
        current.innerHTML = `<a class="card interactive item-card current-material-card" href="${escapeHtml(href)}">
          <div class="item-icon">✨</div>
          <div class="item-main"><span class="homework-number">Домашняя работа №${Number(currentHomework.number || 0)}</span><h3>${escapeHtml(safeText(currentHomework.title, 'Текущее задание'))}</h3><p>${escapeHtml(safeText(currentHomework.subtitle, 'Продолжи работу с опубликованным материалом.'))}</p></div>
          <span class="status-badge status-available">Продолжить</span>
        </a>`;
      } else {
        const publishedHomework = HOMEWORK_DATA.filter((item) => ['available', 'completed'].includes(item.status));
        const everythingCompleted = publishedHomework.length > 0 && publishedHomework.every((item) => item.status === 'completed' || homeworkProgress.completedIds.includes(item.id));
        current.innerHTML = everythingCompleted
          ? '<a class="card interactive item-card current-material-card" href="homework.html"><div class="item-icon">✅</div><div class="item-main"><h3>Все опубликованные задания выполнены</h3><p>Новый материал появится после публикации преподавателем.</p></div><span class="arrow" aria-hidden="true">→</span></a>'
          : '<div class="card disabled empty-state"><div class="empty-state-icon">✨</div><h3>Текущего задания пока нет</h3><p>Последнее доступное домашнее задание появится здесь автоматически.</p></div>';
      }
    }
  }


  function getLessonVocabularyTopic(lesson) {
    const vocabularyId = safeText(lesson?.vocabularyId).trim();
    return VOCABULARY_CATALOG.allTopics.find((topic) => topic.id === vocabularyId)
      || VOCABULARY_CATALOG.allTopics.find((topic) => topic.linkedLessonId === lesson?.id)
      || null;
  }

  function getLessonGrammarTopics(lesson) {
    const ids = Array.isArray(lesson?.grammarIds) ? lesson.grammarIds.map((id) => safeText(id).trim()).filter(Boolean) : [];
    const topics = ids.map((id) => GRAMMAR_DATA.find((topic) => topic.id === id)).filter(Boolean);
    GRAMMAR_DATA.filter((topic) => topic.linkedLessonId === lesson?.id).forEach((topic) => topics.push(topic));
    return [...new Map(topics.map((topic) => [topic.id, topic])).values()];
  }

  function compactGrammarTitle(topic) {
    const id = safeText(topic?.id).toLowerCase();
    if (id.includes('suffix')) return 'Суффиксы';
    if (id.includes('pronoun')) return 'Местоимения';
    const title = safeText(topic?.title, 'Грамматика').split(':')[0].trim();
    return title.length > 22 ? `${title.slice(0, 20).trim()}…` : title;
  }

  function lessonMaterialLinks(lesson, mode = 'hub') {
    const vocabulary = getLessonVocabularyTopic(lesson);
    const grammarTopics = getLessonGrammarTopics(lesson);
    if (!vocabulary && !grammarTopics.length) return '';

    const entries = [];
    const seen = new Set();

    if (vocabulary) {
      const href = vocabulary.page || `vocabulary.html?id=${encodeURIComponent(vocabulary.id)}`;
      const key = `vocab:${href}`;
      if (!seen.has(key)) {
        seen.add(key);
        entries.push({
          type: 'vocab',
          icon: '💥',
          label: 'Словарь',
          shortLabel: 'Словарь',
          title: safeText(vocabulary.title, 'Словарь'),
          href
        });
      }
    }

    grammarTopics.forEach((topic) => {
      if (topic.status === 'locked' || topic.status === 'draft') return;
      const href = topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`;
      const key = `grammar:${href}`;
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({
        type: 'grammar',
        icon: '📐',
        label: 'Грамматика',
        shortLabel: compactGrammarTitle(topic),
        title: safeText(topic.title, 'Грамматика'),
        href
      });
    });

    if (!entries.length) return '';

    if (mode === 'hub') {
      const links = entries.map((entry) => `<a class="lesson-material-chip ${escapeHtml(entry.type)}" href="${escapeHtml(entry.href)}" aria-label="Открыть: ${escapeHtml(entry.label)} — ${escapeHtml(entry.title)}" title="${escapeHtml(entry.title)}"><span class="lesson-material-chip-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span class="lesson-material-chip-label">${escapeHtml(entry.shortLabel)}</span><span class="lesson-material-chip-arrow" aria-hidden="true">→</span></a>`).join('');
      return `<div class="lesson-materials lesson-materials-hub"><span class="lesson-materials-compact-label">Материалы</span><div class="lesson-material-links">${links}</div></div>`;
    }

    const links = entries.map((entry) => `<a class="lesson-material-link ${escapeHtml(entry.type)}" href="${escapeHtml(entry.href)}"><span class="lesson-material-link-main"><span class="lesson-material-icon" aria-hidden="true">${escapeHtml(entry.icon)}</span><span class="lesson-material-text"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.title)}</small></span></span><span class="lesson-material-arrow" aria-hidden="true">→</span></a>`).join('');
    return `<div class="lesson-materials lesson-materials-lesson"><div class="lesson-materials-heading"><span class="eyebrow">Материалы к уроку</span><p>Словарь и грамматика для этого домашнего задания.</p></div><div class="lesson-material-links">${links}</div></div>`;
  }

  function renderHomeworkCard(item, progress) {
    const locked = item.status === 'locked';
    const complete = progress.completedIds.includes(item.id) || item.status === 'completed';
    const title = locked ? '🔒 Скоро' : safeText(item.title, 'Задание');
    const subtitle = locked ? 'Материал откроется после публикации преподавателем.' : safeText(item.subtitle, 'Интерактивное задание');
    const status = complete ? 'completed' : safeText(item.status, 'available');
    const label = complete ? 'Выполнено' : status === 'available' ? 'Доступно' : status === 'locked' ? 'Закрыто' : 'Черновик';

    if (locked) {
      return `<article class="card lesson-hub-card disabled"><div class="lesson-hub-main"><div class="item-icon">🔒</div><div class="item-main"><span class="homework-number">Домашняя работа №${Number(item.number || 0)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div><span class="status-badge status-locked">${escapeHtml(label)}</span></div></article>`;
    }

    const href = item.page || `lesson.html?id=${encodeURIComponent(item.id)}`;
    return `<article class="card lesson-hub-card">
      <a class="lesson-hub-main interactive" href="${escapeHtml(href)}">
        <div class="item-icon">${complete ? '✅' : '📝'}</div>
        <div class="item-main"><span class="homework-number">Домашняя работа №${Number(item.number || 0)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
        <span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>
      </a>
      ${lessonMaterialLinks(item, 'hub')}
    </article>`;
  }

  function renderHomeworkGroup(title, items, progress, emptyText = '') {
    const cards = items.map((item) => renderHomeworkCard(item, progress)).join('');
    const content = cards || `<div class="card homework-group-empty"><p>${escapeHtml(emptyText)}</p></div>`;
    return `<section class="homework-group" aria-label="${escapeHtml(title)}"><div class="homework-group-heading"><h3>${escapeHtml(title)}</h3><span>${items.length}</span></div><div class="homework-group-list">${content}</div></section>`;
  }

  function renderHomework() {
    const progress = window.ProgressService.loadHomeworkProgress();
    const published = HOMEWORK_DATA.filter((item) => item.status !== 'draft');
    const completed = published.filter((item) => progress.completedIds.includes(item.id) || item.status === 'completed').length;
    const percent = safePercent(completed, published.length);
    byId('hw-completed').textContent = completed;
    byId('hw-total').textContent = published.length;
    byId('hw-percent').textContent = `${percent}%`;
    byId('hw-overall-progress').innerHTML = progressMarkup('Общий прогресс', completed, published.length);
    const root = byId('homework-list');
    if (!published.length) {
      root.innerHTML = emptyState('📝', 'Домашних заданий пока нет', 'После первого урока преподаватель добавит сюда интерактивное задание.');
      return;
    }

    const sorted = [...published].sort((a,b) => (a.number || 0) - (b.number || 0));
    const availableItems = sorted.filter((item) => !(progress.completedIds.includes(item.id) || item.status === 'completed'));
    const completedItems = sorted.filter((item) => progress.completedIds.includes(item.id) || item.status === 'completed');

    root.innerHTML = `${renderHomeworkGroup('Доступные', availableItems, progress, 'Все доступные задания уже выполнены.')}${renderHomeworkGroup('Завершённые', completedItems, progress, 'Здесь появятся выполненные домашние работы.')}`;
  }

  function renderGrammar() {
    const progress = window.ProgressService.loadGrammarProgress();
    const published = GRAMMAR_DATA.filter((topic) => topic.status !== 'draft');
    const passed = published.filter((topic) => progress.topics[topic.id]?.passed || topic.passed).length;
    byId('grammar-passed').textContent = passed;
    byId('grammar-total').textContent = published.length;
    byId('grammar-overall-progress').innerHTML = progressMarkup('Общий прогресс', passed, published.length, 'green');
    const root = byId('grammar-list');
    if (!published.length) {
      root.innerHTML = emptyState('📐', 'Темы по грамматике пока не опубликованы', `Материалы будут добавляться по урокам и учебнику «${safeText(student.textbook)}».`);
      return;
    }
    root.innerHTML = [...published].sort((a,b) => (a.order || 0) - (b.order || 0)).map((topic) => {
      const locked = topic.status === 'locked';
      const isPassed = progress.topics[topic.id]?.passed || topic.passed;
      const title = locked ? '🔒 Скоро' : safeText(topic.title, 'Тема по грамматике');
      const tag = locked ? 'div' : 'a';
      const href = locked ? '' : ` href="${escapeHtml(topic.page || `grammar-topic.html?id=${encodeURIComponent(topic.id)}`)}"`;
      return `<${tag} class="card item-card ${locked ? 'disabled' : 'interactive'}"${href}>
        <div class="item-icon">${isPassed ? '✅' : locked ? '🔒' : '📐'}</div>
        <div class="item-main"><h3>${escapeHtml(title)}</h3><p>${locked ? 'Материал пока не опубликован.' : `${escapeHtml(topic.level || student.level)} · ${Number(progress.topics[topic.id]?.attempts || topic.attempts || 0)} попыток`}</p></div>
        <span class="status-badge status-${isPassed ? 'completed' : locked ? 'locked' : 'available'}">${isPassed ? 'Пройдено' : locked ? 'Закрыто' : 'Открыть'}</span>
      </${tag}>`;
    }).join('');
  }

  function renderVocabularyHub() {
    const progress = window.ProgressService.loadVocabularyProgress();
    const totalWords = VOCABULARY_CATALOG.allWords.length;
    const knownCount = Object.entries(progress.words).filter(([wordKey, item]) => VOCABULARY_CATALOG.byKey.has(wordKey) && item.status === 'known').length;
    byId('vocab-known').textContent = knownCount;
    byId('vocab-total').textContent = totalWords;
    byId('vocab-topics').textContent = VOCABULARY_DATA.length;
    byId('vocab-percent').textContent = `${safePercent(knownCount, totalWords)}%`;
    byId('vocab-overall-progress').innerHTML = progressMarkup('Общий прогресс', knownCount, totalWords, 'rose');
    const root = byId('vocabulary-list');
    const filters = byId('vocab-filters');

    const draw = (filter = 'all') => {
      const filtered = VOCABULARY_DATA.filter((topic) => {
        const topicKnown = topic.words.filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
        const complete = topic.words.length > 0 && topicKnown >= topic.words.length;
        if (filter === 'completed') return complete;
        if (filter === 'lesson') return topic.type === 'lesson';
        if (filter === 'extra') return topic.type === 'extra';
        return true;
      });
      if (!filtered.length) {
        root.innerHTML = emptyState('💥', 'Словарных тем пока нет', 'Новые темы появятся после уроков. Повторяющиеся слова автоматически исключаются.');
        return;
      }
      root.innerHTML = filtered.map((topic) => {
        const wordCount = topic.words.length;
        const topicKnown = topic.words.filter((word) => progress.words[word.__wordKey]?.status === 'known').length;
        const complete = wordCount > 0 && topicKnown >= wordCount;
        return `<a class="card item-card interactive" href="${escapeHtml(topic.page || `vocabulary.html?id=${encodeURIComponent(topic.id)}`)}">
          <div class="item-icon">${escapeHtml(topic.icon || '💬')}</div>
          <div class="item-main"><h3>${escapeHtml(topic.title || 'Словарная тема')}</h3><p>${escapeHtml(topic.label || '')} · ${topicKnown} из ${wordCount} слов</p></div>
          <span class="status-badge status-available">Открыть</span>
        </a>`;
      }).join('');
    };
    if (filters) {
      filters.onclick = (event) => {
        const button = event.target.closest('[data-filter]');
        if (!button) return;
        filters.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
        draw(button.dataset.filter);
      };
    }
    draw();
  }

  function renderReadingSections(block) {
    const sections = Array.isArray(block.sections) ? block.sections : [];
    if (!sections.length) {
      const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');
      return `<div class="reading-copy-wrap"><p class="reading-copy">${text}</p></div>`;
    }
    return `<div class="reading-sections">${sections.map((section) => `<section class="reading-section">
      <div class="reading-section-heading"><span class="reading-number">${escapeHtml(section.number || '')}</span><h4>${escapeHtml(section.heading || '')}</h4></div>
      <p class="reading-section-copy">${escapeHtml(section.text || '')}</p>
    </section>`).join('')}</div>`;
  }

  function renderExerciseItem(item, blockId, index) {
    const itemId = safeText(item.id, `${index + 1}`);
    const number = item.number === undefined ? index + 1 : item.number;
    const prompt = escapeHtml(item.prompt || '');
    const inputId = `exercise-${blockId}-${itemId}`.replace(/[^a-zA-Z0-9_-]/g, '-');
    const numberMarkup = number === '' || number === null ? '' : `<span class="exercise-number">${escapeHtml(number)}</span>`;

    if (item.example) {
      return `<div class="exercise-item exercise-example" data-exercise-item="${escapeHtml(itemId)}">
        <div class="exercise-item-header">${numberMarkup}<div class="exercise-prompt">${prompt}</div></div>
        <div class="example-answer"><span>Пример</span><strong>${escapeHtml(item.exampleAnswer || '')}</strong></div>
      </div>`;
    }

    let control = '';
    if (item.input === 'multiple' || item.input === 'single') {
      const inputType = item.input === 'multiple' ? 'checkbox' : 'radio';
      control = `<div class="option-list compact-options">${(item.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(inputId)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('')}</div>`;
    } else if (item.input === 'select') {
      control = `<select id="${escapeHtml(inputId)}"><option value="">Выберите ответ</option>${(item.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('')}</select>`;
    } else if (item.input === 'textarea') {
      control = `<textarea id="${escapeHtml(inputId)}" placeholder="${escapeHtml(item.placeholder || '')}"></textarea>`;
    } else if (item.input === 'gaps') {
      const answers = Array.isArray(item.answers) ? item.answers : [];
      const segments = Array.isArray(item.segments) ? item.segments : [];
      control = `<div class="sentence-gaps" aria-label="${prompt}">${answers.map((answer, gapIndex) => `${gapIndex < segments.length ? `<span>${escapeHtml(segments[gapIndex])}</span>` : ''}<input class="gap-input" data-gap-index="${gapIndex}" aria-label="Пропуск ${gapIndex + 1}" autocomplete="off">`).join('')}${segments.length > answers.length ? `<span>${escapeHtml(segments[segments.length - 1])}</span>` : ''}</div>`;
    } else {
      control = `<input class="text-field" id="${escapeHtml(inputId)}" autocomplete="off" placeholder="${escapeHtml(item.placeholder || '')}">`;
    }

    return `<div class="exercise-item" data-exercise-item="${escapeHtml(itemId)}" data-input-type="${escapeHtml(item.input || 'text')}">
      <div class="exercise-item-header">${numberMarkup}<label class="exercise-prompt" for="${escapeHtml(inputId)}">${prompt}</label></div>
      <div class="exercise-control">${control}</div>
      <div class="feedback" aria-live="polite"></div>
    </div>`;
  }

  function renderLessonBlock(block, index) {
    const id = safeText(block.id, `task-${index}`);
    const title = escapeHtml(block.title || block.prompt || `Task ${index + 1}`);
    const text = escapeHtml(block.text || '').replaceAll('\n', '<br>');

    if (block.type === 'section') {
      return `<header id="lesson-section-${index}" class="lesson-section-title lesson-block" data-lesson-section><span class="lesson-section-step">${escapeHtml(block.__sectionNumber || index + 1)}</span><div><span class="eyebrow">${escapeHtml(block.eyebrow || 'Материал')}</span><h2>${title}</h2>${text ? `<p class="muted">${text}</p>` : ''}</div></header>`;
    }
    if (block.type === 'info') return `<article class="card info-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'tip') return `<article class="card tip-card lesson-block"><h3>${title}</h3><p>${text}</p></article>`;
    if (block.type === 'reading') {
      const sectionCount = Array.isArray(block.sections) ? block.sections.length : 0;
      return `<article class="card lesson-block reading-card"><div class="reading-title"><div><span class="eyebrow">Чтение</span><h3>${title}</h3></div>${sectionCount ? `<span class="reading-count">${sectionCount} разделов</span>` : ''}</div>${renderReadingSections(block)}</article>`;
    }
    if (block.type === 'image') {
      const src = escapeHtml(block.src || '');
      if (!src) return '';
      return `<figure class="card lesson-block lesson-image-card"><img class="lesson-image" src="${src}" alt="${escapeHtml(block.alt || '')}" loading="lazy">${block.caption ? `<figcaption>${escapeHtml(block.caption)}</figcaption>` : ''}</figure>`;
    }
    if (block.type === 'exercise') {
      const items = Array.isArray(block.items) ? block.items : [];
      const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
        ? `<div class="word-bank" aria-label="Банк слов"><strong class="word-bank-label">Банк слов</strong>${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
        : '';
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '';
      return `<article class="card lesson-block exercise-card" data-task="${escapeHtml(id)}" data-type="exercise">
        <div class="exercise-heading"><span class="eyebrow">Упражнение</span><h3>${title}</h3>${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}${player}${wordBank}</div>
        <div class="exercise-items">${items.map((item, itemIndex) => renderExerciseItem(item, id, itemIndex)).join('')}</div>
      </article>`;
    }
    if (block.type === 'text' || block.type === 'translate') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><label class="field-label" for="${escapeHtml(id)}">${title}</label>${block.source ? `<p class="muted">${escapeHtml(block.source)}</p>` : ''}<input class="text-field" id="${escapeHtml(id)}" name="${escapeHtml(id)}" autocomplete="off"><div class="feedback"></div></article>`;
    if (block.type === 'textarea') return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="textarea"><label class="field-label" for="${escapeHtml(id)}">${title}</label><textarea id="${escapeHtml(id)}" name="${escapeHtml(id)}"></textarea><div class="feedback"></div></article>`;
    if (block.type === 'single' || block.type === 'multiple') {
      const inputType = block.type === 'single' ? 'radio' : 'checkbox';
      const options = (block.options || []).map((option, optionIndex) => `<label class="option"><input type="${inputType}" name="${escapeHtml(id)}" value="${optionIndex}"><span>${escapeHtml(option)}</span></label>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="${escapeHtml(block.type)}"><h3>${title}</h3><div class="option-list">${options}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'select') {
      const options = (block.options || []).map((option, optionIndex) => `<option value="${optionIndex}">${escapeHtml(option)}</option>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="select"><label class="field-label" for="${escapeHtml(id)}">${title}</label><select id="${escapeHtml(id)}"><option value="">Выберите ответ</option>${options}</select><div class="feedback"></div></article>`;
    }
    if (block.type === 'match') {
      const rights = (block.pairs || []).map((pair) => pair.right);
      const rows = (block.pairs || []).map((pair, pairIndex) => `<div>${escapeHtml(pair.left)}</div><select data-match-index="${pairIndex}"><option value="">Выберите пару</option>${rights.map((right, rightIndex) => `<option value="${rightIndex}">${escapeHtml(right)}</option>`).join('')}</select>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="match"><h3>${title}</h3><div class="match-grid">${rows}</div><div class="feedback"></div></article>`;
    }
    if (block.type === 'reorder') {
      const chips = shuffled(block.words || []).map((word) => `<button class="word-chip" type="button" data-word="${escapeHtml(word)}">${escapeHtml(word)}</button>`).join('');
      return `<article class="card lesson-block" data-task="${escapeHtml(id)}" data-type="reorder"><h3>${title}</h3><div class="word-chips" data-reorder-source>${chips}</div><label class="field-label" for="${escapeHtml(id)}">Ваше предложение</label><input class="text-field" id="${escapeHtml(id)}" readonly><div class="feedback"></div></article>`;
    }
    if (block.type === 'audio') {
      const player = block.audio ? `<audio class="audio-player" controls preload="none" src="${escapeHtml(block.audio)}"></audio>` : '<p class="muted">Аудиофайл пока не добавлен.</p>';
      const response = block.response === false ? '' : `<input class="text-field" id="${escapeHtml(id)}" aria-label="Ответ на аудиозадание"><div class="feedback"></div>`;
      const taskAttrs = block.response === false ? '' : ` data-task="${escapeHtml(id)}" data-type="audio"`;
      return `<article class="card lesson-block audio-card"${taskAttrs}><div class="audio-icon" aria-hidden="true">🎧</div><div class="audio-content"><h3>${title}</h3>${text ? `<p class="muted">${text}</p>` : ''}${player}${response}</div></article>`;
    }
    return '';
  }

  function normalizeAnswer(value) {
    return safeText(value)
      .normalize('NFKC')
      .replace(/[’‘`]/g, "'")
      .trim()
      .toLocaleLowerCase('en')
      .replace(/[.!?,;:]+$/g, '')
      .replace(/\s+/g, ' ');
  }

  function textAnswerMatches(item, actual) {
    const accepted = Array.isArray(item.acceptedAnswers) && item.acceptedAnswers.length
      ? item.acceptedAnswers
      : Array.isArray(item.answer) ? item.answer : [item.answer];
    return accepted.some((answer) => normalizeAnswer(answer) !== '' && normalizeAnswer(answer) === normalizeAnswer(actual));
  }

  function checkExerciseItem(item, itemNode) {
    const inputType = item.input || 'text';
    let actual;
    let correct = false;

    if (inputType === 'multiple') {
      actual = [...itemNode.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a, b) => a - b);
      const expected = [...(item.answer || [])].map(Number).sort((a, b) => a - b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (inputType === 'single') {
      actual = itemNode.querySelector('input:checked')?.value ?? '';
      correct = Number(actual) === Number(item.answer);
    } else if (inputType === 'select') {
      actual = itemNode.querySelector('select')?.value ?? '';
      correct = actual !== '' && Number(actual) === Number(item.answer);
    } else if (inputType === 'gaps') {
      actual = [...itemNode.querySelectorAll('[data-gap-index]')].map((input) => input.value);
      const expected = Array.isArray(item.answers) ? item.answers : [];
      correct = expected.length > 0 && expected.every((answer, index) => {
        const accepted = Array.isArray(answer) ? answer : [answer];
        return accepted.some((variant) => normalizeAnswer(variant) === normalizeAnswer(actual[index]));
      });
    } else {
      actual = itemNode.querySelector('input, textarea')?.value || '';
      correct = textAnswerMatches(item, actual);
    }

    return { actual, correct };
  }

  function checkExerciseBlock(block, node) {
    const actual = {};
    let correctCount = 0;
    let total = 0;

    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const result = checkExerciseItem(item, itemNode);
      actual[itemId] = result.actual;
      const feedback = itemNode.querySelector('.feedback');

      if (item.scored === false) {
        itemNode.classList.remove('is-correct', 'is-wrong');
        itemNode.classList.add('is-saved');
        if (feedback) {
          feedback.className = 'feedback show neutral';
          feedback.textContent = 'Ответ сохранён для преподавателя.';
        }
        return;
      }

      total += 1;
      if (result.correct) correctCount += 1;
      itemNode.classList.toggle('is-correct', result.correct);
      itemNode.classList.toggle('is-wrong', !result.correct);
      itemNode.classList.remove('is-saved');
      if (feedback) {
        feedback.className = `feedback show ${result.correct ? 'good' : 'bad'}`;
        feedback.textContent = result.correct ? 'Верно!' : safeText(item.explanation, 'Проверь ответ и попробуй ещё раз.');
      }
    });

    return { actual, correctCount, total };
  }

  function checkLessonTask(block, node) {
    if (block.type === 'exercise') return checkExerciseBlock(block, node);
    let actual;
    let correct = false;
    if (block.type === 'single') {
      actual = node.querySelector('input:checked')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'multiple') {
      actual = [...node.querySelectorAll('input:checked')].map((input) => Number(input.value)).sort((a,b) => a-b);
      const expected = [...(block.answer || [])].map(Number).sort((a,b) => a-b);
      correct = JSON.stringify(actual) === JSON.stringify(expected);
    } else if (block.type === 'select') {
      actual = node.querySelector('select')?.value;
      correct = Number(actual) === Number(block.answer);
    } else if (block.type === 'match') {
      actual = [...node.querySelectorAll('[data-match-index]')].map((select) => Number(select.value));
      correct = actual.length > 0 && actual.every((value, index) => value === index);
    } else {
      actual = node.querySelector('input, textarea')?.value || '';
      if (Array.isArray(block.answer)) correct = block.answer.some((answer) => normalizeAnswer(answer) === normalizeAnswer(actual));
      else correct = normalizeAnswer(block.answer) !== '' && normalizeAnswer(block.answer) === normalizeAnswer(actual);
    }
    return { correctCount: correct ? 1 : 0, total: 1, actual };
  }

  function restoreExerciseAnswers(block, node, saved) {
    if (!saved || typeof saved !== 'object') return;
    (Array.isArray(block.items) ? block.items : []).forEach((item, index) => {
      if (item.example) return;
      const itemId = safeText(item.id, `${index + 1}`);
      const value = saved[itemId];
      if (value === undefined) return;
      const itemNode = node.querySelector(`[data-exercise-item="${CSS.escape(itemId)}"]`);
      if (!itemNode) return;
      const inputType = item.input || 'text';
      if (inputType === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        itemNode.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (inputType === 'single') {
        const input = itemNode.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (inputType === 'select') {
        const select = itemNode.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (inputType === 'gaps') {
        const values = Array.isArray(value) ? value : [];
        itemNode.querySelectorAll('[data-gap-index]').forEach((input, gapIndex) => { input.value = safeText(values[gapIndex]); });
      } else {
        const input = itemNode.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  function restoreLessonAnswers(root, blocks, savedAnswers) {
    if (!savedAnswers || typeof savedAnswers !== 'object') return;
    blocks.forEach((block, index) => {
      const taskId = safeText(block.id, `task-${index}`);
      const value = savedAnswers[taskId];
      if (value === undefined) return;
      const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
      if (!node) return;
      if (block.type === 'exercise') {
        restoreExerciseAnswers(block, node, value);
      } else if (block.type === 'single') {
        const input = node.querySelector(`input[value="${CSS.escape(safeText(value))}"]`);
        if (input) input.checked = true;
      } else if (block.type === 'multiple') {
        const selected = new Set(Array.isArray(value) ? value.map(Number) : []);
        node.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = selected.has(Number(input.value)); });
      } else if (block.type === 'select') {
        const select = node.querySelector('select');
        if (select) select.value = safeText(value);
      } else if (block.type === 'match') {
        const values = Array.isArray(value) ? value : [];
        node.querySelectorAll('[data-match-index]').forEach((select, matchIndex) => { select.value = safeText(values[matchIndex]); });
      } else {
        const input = node.querySelector('input, textarea');
        if (input) input.value = safeText(value);
      }
    });
  }

  async function renderLesson() {
    const id = queryParam('id');
    const lessonRecord = HOMEWORK_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('lesson-root');
    if (!lessonRecord || lessonRecord.status === 'locked') {
      root.innerHTML = emptyState('📝', 'Задание пока не опубликовано', 'Преподаватель добавит материал после урока.');
      return;
    }

    byId('lesson-hero-title').textContent = safeText(lessonRecord.title, 'Задание');
    byId('lesson-hero-subtitle').textContent = `Домашняя работа №${Number(lessonRecord.number || 0)} · ${safeText(lessonRecord.subtitle, 'Интерактивная практика')}`;
    root.innerHTML = '<div class="card empty-state compact-empty"><div class="empty-state-icon">⏳</div><h3>Загружаем задание…</h3></div>';

    let lesson;
    try {
      lesson = await resolveLessonContent(lessonRecord);
    } catch (error) {
      console.error('Ошибка загрузки содержимого урока:', error);
      root.innerHTML = emptyState('⚠️', 'Не удалось загрузить задание', 'Проверь наличие JSON-файла урока в папке data/lessons и правильность его структуры.');
      return;
    }

    const blocks = Array.isArray(lesson?.blocks) ? lesson.blocks : [];
    if (!blocks.length) {
      root.innerHTML = emptyState('📝', 'Задание пока не опубликовано', 'Содержание появится после подготовки преподавателем.');
      return;
    }

    const progress = window.ProgressService.loadHomeworkProgress();
    const savedResult = progress.results[lesson.id];
    const pointsLabel = Number(lesson.totalPoints || 0) > 0 ? `${escapeHtml(lesson.totalPoints)} проверяемых ответов` : 'Без автоматической оценки';
    const hasManualResponses = blocks.some((block) => block.type === 'exercise' && (block.items || []).some((item) => item.scored === false));
    const lessonSections = blocks
      .map((block, blockIndex) => block.type === 'section' ? { block, blockIndex } : null)
      .filter(Boolean);
    const roadmap = lessonSections.length
      ? `<nav class="card lesson-roadmap" aria-label="План домашнего задания"><div class="lesson-roadmap-heading"><span class="eyebrow">План задания</span><p>Проходи разделы по порядку — ответы сохранятся после проверки.</p></div><ol>${lessonSections.map(({ block, blockIndex }, sectionIndex) => `<li><a href="#lesson-section-${blockIndex}"><span>${sectionIndex + 1}</span><strong>${escapeHtml(block.title || `Часть ${sectionIndex + 1}`)}</strong></a></li>`).join('')}</ol></nav>`
      : '';
    let sectionNumber = 0;
    const renderedBlocks = blocks.map((block, blockIndex) => {
      if (block.type === 'section') sectionNumber += 1;
      return renderLessonBlock(block.type === 'section' ? { ...block, __sectionNumber: sectionNumber } : block, blockIndex);
    }).join('');
    const linkedMaterials = lessonMaterialLinks(lesson, 'lesson');
    root.innerHTML = `<div class="card lesson-intro"><div><span class="eyebrow">Домашняя работа №${Number(lesson.number || 0)}</span><p>${escapeHtml(lesson.subtitle || '')}</p></div><span class="lesson-points">${pointsLabel}</span></div>
      ${linkedMaterials}
      ${roadmap}
      <div id="lesson-blocks">${renderedBlocks}</div>
      <div class="card section lesson-actions"><div id="lesson-result" aria-live="polite"></div><div class="button-row"><button class="btn btn-primary" id="check-lesson" type="button">Проверить ответы</button><button class="btn btn-secondary" id="submit-lesson" type="button" ${savedResult ? '' : 'disabled'}>Отправить преподавателю</button></div><p class="muted save-note">После проверки ответы сохраняются на устройстве и синхронизируются с Supabase.</p></div>`;

    restoreLessonAnswers(root, blocks, savedResult?.answers);
    if (savedResult && Number(savedResult.total) > 0) {
      byId('lesson-result').innerHTML = `<h3>Сохранённый результат: ${Number(savedResult.correct || 0)} из ${Number(savedResult.total || 0)}</h3><p class="muted">${Number(savedResult.percent || 0)}% правильных ответов</p>`;
    }

    root.querySelectorAll('[data-reorder-source]').forEach((source) => {
      source.addEventListener('click', (event) => {
        const chip = event.target.closest('[data-word]');
        if (!chip) return;
        chip.classList.toggle('selected');
        const parent = source.closest('[data-task]');
        const input = parent.querySelector('input');
        const selected = [...source.querySelectorAll('.selected')].map((item) => item.dataset.word);
        input.value = selected.join(' ');
      });
    });

    byId('check-lesson').addEventListener('click', () => {
      const checkableTypes = ['text','textarea','single','multiple','select','match','reorder','translate','audio','exercise'];
      const checkable = blocks.filter((block) => checkableTypes.includes(block.type) && !(block.type === 'audio' && block.response === false));
      let correct = 0;
      let total = 0;
      const answers = {};
      checkable.forEach((block, index) => {
        const taskId = safeText(block.id, `task-${index}`);
        const node = root.querySelector(`[data-task="${CSS.escape(taskId)}"]`);
        if (!node) return;
        const result = checkLessonTask(block, node);
        answers[taskId] = result.actual;
        correct += Number(result.correctCount || 0);
        total += Number(result.total || 0);
        if (block.type !== 'exercise') {
          const feedback = node.querySelector('.feedback');
          const isCorrect = Number(result.correctCount || 0) === Number(result.total || 0);
          if (feedback) {
            feedback.className = `feedback show ${isCorrect ? 'good' : 'bad'}`;
            feedback.textContent = isCorrect ? 'Верно!' : safeText(block.explanation, 'Проверь ответ и попробуй ещё раз.');
          }
        }
      });
      const percent = safePercent(correct, total);
      const manualNote = hasManualResponses ? ' · развёрнутый ответ сохранён отдельно и не входит в оценку' : '';
      byId('lesson-result').innerHTML = `<h3>Результат: ${correct} из ${total}</h3><p class="muted">${percent}% правильных ответов${manualNote}</p>`;
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      updatedProgress.results[lesson.id] = { correct, total, percent, answers, checkedAt: new Date().toISOString() };
      if (total > 0 && correct === total && !updatedProgress.completedIds.includes(lesson.id)) updatedProgress.completedIds.push(lesson.id);
      window.ProgressService.saveHomeworkProgress(updatedProgress);
      byId('submit-lesson').disabled = false;
    });
    byId('submit-lesson').addEventListener('click', () => {
      const updatedProgress = window.ProgressService.loadHomeworkProgress();
      updatedProgress.submissions[lesson.id] = { savedAt: new Date().toISOString(), status: CloudService.isConfigured() ? 'pending-cloud' : 'local' };
      if (!updatedProgress.completedIds.includes(lesson.id)) updatedProgress.completedIds.push(lesson.id);
      window.ProgressService.saveHomeworkProgress(updatedProgress);
      showToast(CloudService.isConfigured() ? 'Ответы сохранены и отправляются в Supabase.' : 'Ответы сохранены на этом устройстве.');
    });
  }

  
  function grammarTable(table) {
    if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) return '';
    return `<div class="table-wrap"><table><thead><tr>${table.headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderGrammarExercise(block, index) {
    const id = safeText(block.id, `grammar-exercise-${index + 1}`);
    const title = escapeHtml(block.title || `Упражнение ${index + 1}`);
    const difficulty = safeText(block.difficulty, 'Практика');
    const wordBank = Array.isArray(block.wordBank) && block.wordBank.length
      ? `<div class="word-bank" aria-label="Банк слов"><strong class="word-bank-label">Банк слов</strong>${block.wordBank.map((word) => `<span>${escapeHtml(word)}</span>`).join('')}</div>`
      : '';
    return `<article class="card lesson-block exercise-card grammar-exercise-card" data-task="${escapeHtml(id)}" data-type="exercise" data-grammar-exercise="${index}">
      <div class="exercise-heading grammar-exercise-heading">
        <div class="grammar-step-row"><span class="grammar-step-badge">Шаг ${index + 1}</span><span class="grammar-difficulty">${escapeHtml(difficulty)}</span></div>
        <h3>${title}</h3>
        ${block.instructions ? `<p class="muted exercise-instructions">${escapeHtml(block.instructions)}</p>` : ''}
        ${wordBank}
      </div>
      <div class="exercise-items">${(Array.isArray(block.items) ? block.items : []).map((item, itemIndex) => renderExerciseItem(item, id, itemIndex)).join('')}</div>
    </article>`;
  }

  function renderGrammarPractice(topic, root) {
    const exercises = Array.isArray(topic.exercises) ? topic.exercises : [];
    if (!exercises.length) {
      root.innerHTML = emptyState('🧩', 'Упражнения пока не добавлены', 'Они появятся вместе с материалом преподавателя.');
      return;
    }

    const renderPractice = () => {
      root.innerHTML = `${exercises.map((block, index) => renderGrammarExercise(block, index)).join('')}
        <div class="card grammar-practice-actions">
          <div id="grammar-result"><h3>Выполняй по шагам</h3><p class="muted">Начни с простых заданий и переходи к более сложным.</p></div>
          <div class="button-row"><button class="btn btn-primary" type="button" id="check-grammar">Проверить упражнения</button><button class="btn btn-secondary" type="button" id="retry-grammar">Начать заново</button></div>
        </div>`;

      byId('check-grammar').addEventListener('click', () => {
        let correct = 0;
        let total = 0;
        exercises.forEach((block, index) => {
          const node = root.querySelector(`[data-grammar-exercise="${index}"]`);
          if (!node) return;
          const result = checkExerciseBlock(block, node);
          correct += Number(result.correctCount || 0);
          total += Number(result.total || 0);
        });
        const percent = safePercent(correct, total);
        byId('grammar-result').innerHTML = `<h3>Результат: ${correct} из ${total}</h3><p class="muted">${percent}% правильных ответов</p>${percent === 100 ? '<p class="grammar-success-note">Отлично! Тема усвоена, можно двигаться дальше.</p>' : '<p class="grammar-success-note">Повтори таблицы и раздел «Частые ошибки», затем попробуй ещё раз.</p>'}`;
        const progress = window.ProgressService.loadGrammarProgress();
        const previous = progress.topics[topic.id] || {};
        progress.topics[topic.id] = {
          passed: percent === 100,
          attempts: Number(previous.attempts || 0) + 1,
          bestScore: Math.max(Number(previous.bestScore || 0), percent),
          updatedAt: new Date().toISOString()
        };
        window.ProgressService.saveGrammarProgress(progress);
      });

      byId('retry-grammar').addEventListener('click', renderPractice);
    };

    renderPractice();
  }

  function renderGrammarTopic() {
    const id = queryParam('id');
    const topic = GRAMMAR_DATA.find((item) => item.id === id && item.status !== 'draft');
    const root = byId('grammar-topic-root');
    if (!topic || topic.status === 'locked') {
      root.innerHTML = emptyState('📐', 'Эта тема по грамматике пока не опубликована', 'Материал появится после публикации преподавателем.');
      return;
    }

    byId('grammar-hero-title').textContent = safeText(topic.title, 'Грамматика');
    byId('grammar-hero-subtitle').textContent = `${safeText(topic.level, student.level)} уровень · объяснения и упражнения`;

    const glanceCards = Array.isArray(topic.glanceCards) ? topic.glanceCards : [];
    const anchorLinks = Array.isArray(topic.anchorLinks) ? topic.anchorLinks : [];
    const miniRules = Array.isArray(topic.miniRules) ? topic.miniRules : [];
    const tables = Array.isArray(topic.tables) ? topic.tables : (topic.table ? [topic.table] : []);
    const exampleGroups = Array.isArray(topic.exampleGroups) ? topic.exampleGroups : [];
    const examples = Array.isArray(topic.examples) ? topic.examples : [];
    const mistakes = Array.isArray(topic.commonMistakes) ? topic.commonMistakes : [];

    root.innerHTML = `
      <article class="card grammar-intro-card">
        <span class="eyebrow">Грамматика</span>
        <h2>${escapeHtml(topic.title)}</h2>
        <p class="muted grammar-lead">${escapeHtml(topic.explanation || '')}</p>
        ${topic.formula ? `<div class="grammar-formula-box"><strong>Краткая формула</strong><p>${escapeHtml(topic.formula)}</p></div>` : ''}
        ${anchorLinks.length ? `<div class="grammar-anchor-links">${anchorLinks.map((link) => `<a class="grammar-anchor-link" href="#${escapeHtml(link.id)}">${escapeHtml(link.title)}</a>`).join('')}</div>` : ''}
      </article>

      ${glanceCards.length ? `<section class="section" id="grammar-at-a-glance" aria-labelledby="grammar-at-a-glance-title"><div class="section-heading"><div><span class="eyebrow">Быстрый обзор</span><h2 id="grammar-at-a-glance-title">Как быстро выбрать правильную форму</h2></div></div><div class="grammar-glance-grid">${glanceCards.map((card) => `<article class="card grammar-glance-card"><div class="grammar-glance-head"><span class="grammar-glance-icon">${escapeHtml(card.icon || '✦')}</span><div><h3>${escapeHtml(card.label || '')}</h3><p class="muted">${escapeHtml(card.hint || '')}</p></div></div><div class="grammar-pattern">${escapeHtml(card.pattern || '')}</div><p class="grammar-example-sentence">${escapeHtml(card.example || '')}</p></article>`).join('')}</div></section>` : ''}

      ${miniRules.length ? `<section class="section" id="grammar-rule-map" aria-labelledby="grammar-rule-map-title"><div class="section-heading"><div><span class="eyebrow">Правила</span><h2 id="grammar-rule-map-title">Памятка по шагам</h2></div></div><div class="grammar-mini-grid">${miniRules.map((rule) => `<article class="card grammar-mini-card"><h3>${escapeHtml(rule.title || '')}</h3><p>${escapeHtml(rule.text || '')}</p>${rule.example ? `<div class="grammar-mini-example">${escapeHtml(rule.example)}</div>` : ''}</article>`).join('')}</div></section>` : ''}

      ${tables.length ? `<section class="section" id="grammar-tables" aria-labelledby="grammar-tables-title"><div class="section-heading"><div><span class="eyebrow">Таблицы</span><h2 id="grammar-tables-title">Таблицы</h2></div></div><div class="list">${tables.map((table) => `<article class="card lesson-block"><h3>${escapeHtml(table.title || 'Таблица')}</h3>${grammarTable(table)}</article>`).join('')}</div></section>` : ''}

      ${exampleGroups.length || examples.length ? `<section class="section" id="grammar-examples" aria-labelledby="grammar-examples-title"><div class="section-heading"><div><span class="eyebrow">Примеры</span><h2 id="grammar-examples-title">Примеры в контексте</h2></div></div><div class="list">${exampleGroups.map((group) => `<article class="card lesson-block grammar-example-group"><h3>${escapeHtml(group.title || 'Примеры')}</h3><div class="list">${(group.items || []).map((item) => `<p class="grammar-example-item">• ${escapeHtml(item)}</p>`).join('')}</div></article>`).join('')}${examples.length ? `<article class="card lesson-block grammar-example-group"><h3>Другие примеры</h3><div class="list">${examples.map((example) => `<p class="grammar-example-item">• ${escapeHtml(example)}</p>`).join('')}</div></article>` : ''}</div></section>` : ''}

      ${mistakes.length ? `<section class="section" id="grammar-mistakes" aria-labelledby="grammar-mistakes-title"><div class="section-heading"><div><span class="eyebrow">Ошибки</span><h2 id="grammar-mistakes-title">Частые ошибки</h2></div></div><article class="card info-card lesson-block"><div class="list">${mistakes.map((mistake) => `<p>• ${escapeHtml(mistake)}</p>`).join('')}</div></article></section>` : ''}

      <section class="section" id="grammar-practice-section" aria-labelledby="grammar-practice-title"><div class="section-heading"><div><span class="eyebrow">Практика</span><h2 id="grammar-practice-title">${Array.isArray(topic.exercises) ? topic.exercises.length : 0} упражнений: от простого к сложному</h2></div></div><div id="grammar-quiz"></div></section>
    `;

    renderGrammarPractice(topic, byId('grammar-quiz'));
  }


  function getTopicProgress(progress, topicId) {
    if (!progress.topics[topicId]) progress.topics[topicId] = { tests: [] };
    if (!Array.isArray(progress.topics[topicId].tests)) progress.topics[topicId].tests = [];
    return progress.topics[topicId];
  }

  function setWordStatus(progress, word, topicId, status) {
    const now = new Date().toISOString();
    const previous = progress.words[word.__wordKey] || {};
    progress.words[word.__wordKey] = {
      status,
      topicId: previous.topicId || topicId,
      learnedAt: status === 'known' ? (previous.learnedAt || now) : null,
      updatedAt: now
    };
  }

  function renderVocabulary() {
    const id = queryParam('id');
    const topic = VOCABULARY_CATALOG.allTopics.find((item) => item.id === id);
    const root = byId('vocabulary-root');
    if (!topic || !Array.isArray(topic.words) || !topic.words.length) {
      root.innerHTML = emptyState('💥', 'В этой теме пока нет слов', 'Преподаватель добавит список после урока. Слова из предыдущих тем здесь не повторяются.');
      return;
    }
    byId('vocab-hero-title').textContent = safeText(topic.title, 'Словарь');
    byId('vocab-hero-subtitle').textContent = `${safeText(topic.label, 'Словарная тема')} · ${topic.words.length} уникальных слов`;
    const progress = window.ProgressService.loadVocabularyProgress();
    const topicProgress = getTopicProgress(progress, topic.id);
    let mode = 'cards';
    let cardQueue = [];
    let testState = null;

    root.innerHTML = `<div class="mode-tabs" id="vocab-modes" aria-label="Режим тренировки">
      <button class="mode-btn active" type="button" data-mode="cards">Новые слова</button>
      <button class="mode-btn" type="button" data-mode="test">Тест</button>
      <button class="mode-btn" type="button" data-mode="all">Все слова</button>
      <button class="mode-btn" type="button" data-mode="difficult">Трудные слова</button>
    </div><div id="vocab-mode-root" class="section"></div>`;
    const modeRoot = byId('vocab-mode-root');

    const save = () => window.ProgressService.saveVocabularyProgress(progress);
    const resetCardQueue = () => {
      cardQueue = shuffled(topic.words.filter((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return mode === 'difficult' ? status === 'difficult' : status !== 'known';
      }));
    };

    const drawCard = () => {
      if (!cardQueue.length) {
        const isDifficult = mode === 'difficult';
        modeRoot.innerHTML = emptyState(
          isDifficult ? '🌟' : '🎉',
          isDifficult ? 'Трудных слов пока нет' : 'Все новые слова в этой теме просмотрены',
          isDifficult ? 'Отметь слово как «Трудное», и оно появится здесь.' : 'Выученные слова остаются в разделе «Все слова» и не повторяются в режиме «Новые слова».'
        );
        return;
      }
      const word = cardQueue[0];
      const remaining = cardQueue.length;
      modeRoot.innerHTML = `<div class="flash-counter">Осталось: ${remaining}</div><div class="flashcard-stage"><div class="flashcard" id="flashcard" tabindex="0" role="button" aria-label="Перевернуть карточку">
        <div class="flash-face flash-front"><div class="flash-word">${escapeHtml(word.en)}</div>${word.transcription ? `<div class="flash-transcription">${escapeHtml(word.transcription)}</div>` : ''}<p class="muted">Нажми, чтобы увидеть перевод</p></div>
        <div class="flash-face flash-back"><div class="flash-word">${escapeHtml(word.ru)}</div>${word.exampleEn ? `<p class="flash-example">${escapeHtml(word.exampleEn)}${word.exampleRu ? `<br>${escapeHtml(word.exampleRu)}` : ''}</p>` : ''}</div>
      </div></div><div class="trainer-actions"><button class="btn btn-danger" id="word-difficult" type="button">Трудное</button><button class="btn btn-success" id="word-known" type="button">Знаю</button></div>`;
      const flashcard = byId('flashcard');
      const flip = () => flashcard.classList.toggle('flipped');
      flashcard.addEventListener('click', flip);
      flashcard.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); flip(); } });
      byId('word-known').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'known');
        cardQueue.shift();
        save();
        drawCard();
      });
      byId('word-difficult').addEventListener('click', () => {
        setWordStatus(progress, word, topic.id, 'difficult');
        cardQueue.shift();
        save();
        drawCard();
      });
    };

    const startTest = () => {
      if (topic.words.length < 4) {
        modeRoot.innerHTML = emptyState('🧩', 'Для теста нужно минимум 4 слова', 'Добавь больше уникальных слов, чтобы появились четыре варианта ответа.');
        return;
      }
      testState = { words: shuffled(topic.words), index: 0, firstTryCorrect: 0, answered: false, firstAnswers: {} };
      drawQuestion();
    };

    const finishTest = () => {
      const result = {
        score: testState.firstTryCorrect,
        total: testState.words.length,
        percent: safePercent(testState.firstTryCorrect, testState.words.length),
        answers: testState.firstAnswers,
        completedAt: new Date().toISOString()
      };
      topicProgress.tests.push(result);
      save();
      modeRoot.innerHTML = `<div class="card empty-state"><div class="empty-state-icon">🏁</div><h3>Тест завершён</h3><p>Правильно с первой попытки: ${result.score} из ${result.total}</p><div class="button-row" style="justify-content:center"><button class="btn btn-primary" id="restart-vocab-test" type="button">Пройти ещё раз</button></div></div>`;
      byId('restart-vocab-test').addEventListener('click', startTest);
    };

    const drawQuestion = () => {
      if (testState.index >= testState.words.length) { finishTest(); return; }
      const word = testState.words[testState.index];
      const distractors = shuffled(topic.words.filter((item) => item.__wordKey !== word.__wordKey)).slice(0, 3);
      const options = shuffled([word, ...distractors]);
      testState.answered = false;
      modeRoot.innerHTML = `<div class="flash-counter">Вопрос ${testState.index + 1} из ${testState.words.length}</div><article class="card"><span class="eyebrow">Выбери перевод</span><h2 class="flash-word">${escapeHtml(word.en)}</h2>${word.transcription ? `<p class="muted">${escapeHtml(word.transcription)}</p>` : ''}<div class="option-list section">${options.map((option) => `<button class="quiz-option" type="button" data-answer-key="${escapeHtml(option.__wordKey)}">${escapeHtml(option.ru)}</button>`).join('')}</div><div id="vocab-test-feedback" class="feedback"></div><div class="button-row"><button class="btn btn-primary" id="next-vocab-question" type="button" disabled>Следующее слово</button></div></article>`;
      modeRoot.querySelectorAll('[data-answer-key]').forEach((button) => {
        button.addEventListener('click', () => {
          if (testState.answered) return;
          testState.answered = true;
          const correct = button.dataset.answerKey === word.__wordKey;
          testState.firstAnswers[word.__wordKey] = { correct, selected: button.dataset.answerKey };
          if (correct) {
            testState.firstTryCorrect += 1;
            setWordStatus(progress, word, topic.id, 'known');
          } else {
            setWordStatus(progress, word, topic.id, 'difficult');
          }
          save();
          modeRoot.querySelectorAll('[data-answer-key]').forEach((optionButton) => {
            optionButton.disabled = true;
            if (optionButton.dataset.answerKey === word.__wordKey) optionButton.classList.add('correct');
          });
          if (!correct) button.classList.add('wrong');
          const feedback = byId('vocab-test-feedback');
          feedback.className = `feedback show ${correct ? 'good' : 'bad'}`;
          feedback.textContent = correct ? 'Верно с первой попытки!' : `Правильный ответ: ${word.ru}`;
          byId('next-vocab-question').disabled = false;
        });
      });
      byId('next-vocab-question').addEventListener('click', () => { testState.index += 1; drawQuestion(); });
    };

    const drawAllWords = () => {
      modeRoot.innerHTML = `<div class="words-grid">${topic.words.map((word) => {
        const status = progress.words[word.__wordKey]?.status;
        return `<article class="card word-card ${status === 'known' ? 'known' : ''} ${status === 'difficult' ? 'difficult' : ''}"><strong>${escapeHtml(word.en)}</strong><span>${escapeHtml(word.ru)}</span>${word.transcription ? `<span>${escapeHtml(word.transcription)}</span>` : ''}</article>`;
      }).join('')}</div>`;
    };

    const drawMode = () => {
      if (mode === 'cards' || mode === 'difficult') {
        resetCardQueue();
        drawCard();
      } else if (mode === 'test') startTest();
      else drawAllWords();
    };
    byId('vocab-modes').addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      mode = button.dataset.mode;
      byId('vocab-modes').querySelectorAll('[data-mode]').forEach((item) => item.classList.toggle('active', item === button));
      drawMode();
    });
    drawMode();
  }

  async function refreshCurrentView() {
    const view = document.body.dataset.view;
    const renderers = {
      home: renderHome,
      homework: renderHomework,
      grammar: renderGrammar,
      'vocabulary-hub': renderVocabularyHub,
      lesson: renderLesson,
      'grammar-topic': renderGrammarTopic,
      vocabulary: renderVocabulary
    };
    try {
      await renderers[view]?.();
    } catch (error) {
      console.error('Ошибка отображения страницы:', error);
      const main = document.querySelector('main');
      if (main) main.innerHTML = emptyState('⚠️', 'Не удалось открыть страницу', 'Проверь структуру данных и обнови страницу.');
    }
  }

  async function init() {
    fillConfig();
    markNavigation();
    try {
      await loadHomeworkData();
    } catch (error) {
      console.error('Lesson catalogue loading error:', error);
      HOMEWORK_DATA = [];
      window.HOMEWORK_DATA = HOMEWORK_DATA;
    }
    await refreshCurrentView();
    if (!CloudService.isConfigured()) return;
    try {
      await CloudService.init();
      await window.ProgressService.syncFromCloud();
      await refreshCurrentView();
    } catch (error) {
      console.error('Supabase connection error:', error);
      const detail = safeText(error?.message || error?.details || error?.hint);
      showToast(detail ? `Ошибка Supabase: ${detail}` : 'Supabase временно недоступен.');
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
