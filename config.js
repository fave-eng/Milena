window.APP_CONFIG = {
  student: {
    id: "milena",
    nameRu: "Милена",
    nameEn: "Milena",
    level: "A1",
    textbook: "Outcomes",
    textbookEdition: "A2 · 2nd edition"
  },

  supabase: {
    url: "https://cbpvujtyuepioqmrreji.supabase.co",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNicHZ1anR5dWVwaW9xbXJyZWppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2MDY4NTMsImV4cCI6MjA5OTE4Mjg1M30.W_5ms3GRCRJhcww9zeYZU3MxcIE87pfQlHynzHoAb4U",
    tables: {
      homework: "homework_progress",
      vocabulary: "vocabulary_progress",
      vocabularyTopics: "vocabulary_topic_progress",
      grammar: "grammar_progress"
    }
  },

  features: {
    homework: true,
    vocabulary: true,
    wordPronunciation: true,
    grammar: true,
    cloudSync: true,
    telegramNotifications: true
  }
};
