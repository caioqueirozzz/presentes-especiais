-- Áudio do cliente (Fase 4): o arquivo fica no Armazem; a transcrição numa coluna própria, fora do body
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_key TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_bytes INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT
  CHECK (transcription_status IN ('OK', 'FALHOU', 'NAO_TRANSCRITO'));
