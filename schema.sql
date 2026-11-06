CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  telefone TEXT NOT NULL UNIQUE,
  email TEXT,
  cep TEXT, logradouro TEXT, numero TEXT, bairro TEXT, cidade TEXT, uf TEXT,
  criado_em TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profissionais (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS servicos (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  duracao_min INTEGER NOT NULL,
  preco NUMERIC(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS agendamentos (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  profissional_id INTEGER NOT NULL REFERENCES profissionais(id),
  servico_id INTEGER NOT NULL REFERENCES servicos(id),
  inicio TEXT NOT NULL,            -- 'YYYY-MM-DD HH:MM' (horário local da loja)
  fim TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado','cancelado','concluido')),
  lembrete_enviado INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ag_prof_inicio ON agendamentos(profissional_id, inicio);

CREATE TABLE IF NOT EXISTS lista_espera (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  profissional_id INTEGER REFERENCES profissionais(id),  -- NULL = qualquer profissional
  servico_id INTEGER NOT NULL REFERENCES servicos(id),
  data TEXT NOT NULL,              -- 'YYYY-MM-DD'
  status TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando','notificado','atendido')),
  criado_em TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mensagens (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  agendamento_id INTEGER REFERENCES agendamentos(id),
  tipo TEXT NOT NULL,              -- confirmacao | lembrete | vaga_liberada | cancelamento
  conteudo TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'enviada',
  criado_em TIMESTAMPTZ DEFAULT now()
);
