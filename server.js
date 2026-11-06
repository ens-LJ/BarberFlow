process.env.TZ = process.env.TZ || 'America/Sao_Paulo'; // o Render roda em UTC; precisa vir antes de qualquer Date
const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const url = process.env.DATABASE_URL;
if (!url) { console.error('Defina a variável DATABASE_URL.'); process.exit(1); }
const pool = new Pool({ connectionString: url, ssl: /render\.com/.test(url) ? { rejectUnauthorized: false } : false });
const q = (sql, p) => pool.query(sql, p).then(r => r.rows);
const q1 = async (sql, p) => (await q(sql, p))[0];

// ---------- utilitários ----------
const ABRE = 9 * 60, FECHA = 19 * 60, PASSO = 30; // 09:00–19:00, grade de 30 min
const pad = n => String(n).padStart(2, '0');
const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const fmt = min => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const parse = s => new Date(s.replace(' ', 'T'));
const br = s => `${s.slice(8, 10)}/${s.slice(5, 7)} às ${s.slice(11)}`;
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const h = fn => (req, res) => fn(req, res).catch(e => { console.error(e); res.status(500).json({ erro: 'Erro interno' }); });

async function init() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const { n } = await q1('SELECT COUNT(*)::int n FROM profissionais');
  if (!n) {
    for (const nome of ['Rafael', 'Bruno', 'Camila']) await q('INSERT INTO profissionais(nome) VALUES ($1)', [nome]);
    for (const s of [['Corte', 30, 45], ['Barba', 30, 35], ['Corte + Barba', 60, 70], ['Sobrancelha', 15, 15]])
      await q('INSERT INTO servicos(nome,duracao_min,preco) VALUES ($1,$2,$3)', s);
  }
}

const detalhe = id => q1(`
  SELECT a.*, c.nome AS cliente, p.nome AS profissional, s.nome AS servico, s.duracao_min
  FROM agendamentos a
  JOIN clientes c ON c.id = a.cliente_id
  JOIN profissionais p ON p.id = a.profissional_id
  JOIN servicos s ON s.id = a.servico_id
  WHERE a.id = $1`, [id]);

// Troque o corpo desta função pela API do WhatsApp (Cloud API, Twilio, Z-API...) ou SMS/e-mail.
async function enviar(clienteId, agendamentoId, tipo, texto) {
  console.log(`[${tipo}] cliente ${clienteId}: ${texto}`);
  await q('INSERT INTO mensagens(cliente_id,agendamento_id,tipo,conteudo,status) VALUES ($1,$2,$3,$4,$5)',
    [clienteId, agendamentoId, tipo, texto, 'enviada']);
}

async function livres(profId, servId, data) {
  const s = await q1('SELECT duracao_min AS d FROM servicos WHERE id=$1', [servId]);
  if (!s) return [];
  const ocupados = (await q(`SELECT inicio, fim FROM agendamentos
      WHERE profissional_id=$1 AND status='agendado' AND substr(inicio,1,10)=$2`, [profId, data]))
    .map(o => [toMin(o.inicio.slice(11)), toMin(o.fim.slice(11))]);
  const agora = new Date(), out = [];
  for (let t = ABRE; t + s.d <= FECHA; t += PASSO) {
    if (parse(`${data} ${fmt(t)}`) <= agora) continue;
    if (ocupados.some(([i, f]) => t < f && t + s.d > i)) continue;
    out.push(fmt(t));
  }
  return out;
}

// Avisa a lista de espera quando um horário vaga
async function avisarEspera(a) {
  const data = a.inicio.slice(0, 10), hora = a.inicio.slice(11);
  const fila = await q(`
    SELECT e.*, s.nome AS servico FROM lista_espera e JOIN servicos s ON s.id = e.servico_id
    WHERE e.status='aguardando' AND e.data=$1 AND (e.profissional_id IS NULL OR e.profissional_id=$2)
    ORDER BY e.id`, [data, a.profissional_id]);
  for (const e of fila) {
    if (!(await livres(a.profissional_id, e.servico_id, data)).includes(hora)) continue; // serviço não cabe na vaga
    await enviar(e.cliente_id, null, 'vaga_liberada',
      `Vagou um horário! ${e.servico} com ${a.profissional} em ${br(a.inicio)}. Entre no BarberFlow e agende — vale quem confirmar primeiro.`);
    await q("UPDATE lista_espera SET status='notificado' WHERE id=$1", [e.id]);
  }
}

async function criarAgendamento({ cliente_id, profissional_id, servico_id, data, hora }) {
  const s = await q1('SELECT duracao_min AS d FROM servicos WHERE id=$1', [servico_id]);
  if (!s) throw new Error('Serviço inválido');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock($1::bigint)', [profissional_id]); // evita dupla reserva
    if (!(await livres(profissional_id, servico_id, data)).includes(hora)) throw new Error('Horário indisponível');
    const r = await c.query(`INSERT INTO agendamentos(cliente_id,profissional_id,servico_id,inicio,fim)
      VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [cliente_id, profissional_id, servico_id, `${data} ${hora}`, `${data} ${fmt(toMin(hora) + s.d)}`]);
    await c.query('COMMIT');
    return r.rows[0].id;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// ---------- API ----------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => {
  const f = path.join(__dirname, 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.status(404).send('index.html não encontrado. Coloque-o em public/index.html (ao lado do server.js).');
});

app.get('/api/catalogo', h(async (_req, res) => res.json({
  profissionais: await q('SELECT id,nome FROM profissionais WHERE ativo=1 ORDER BY id'),
  servicos: (await q('SELECT * FROM servicos ORDER BY id')).map(s => ({ ...s, preco: Number(s.preco) }))
})));

// ViaCEP (proxy no servidor, evita CORS e permite validar)
app.get('/api/cep/:cep', async (req, res) => {
  const cep = req.params.cep.replace(/\D/g, '');
  if (cep.length !== 8) return res.status(400).json({ erro: 'CEP inválido' });
  try {
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    const d = await r.json();
    if (d.erro) return res.status(404).json({ erro: 'CEP não encontrado' });
    res.json({ cep: d.cep, logradouro: d.logradouro, bairro: d.bairro, cidade: d.localidade, uf: d.uf });
  } catch { res.status(502).json({ erro: 'ViaCEP indisponível' }); }
});

// Cadastro/atualização de cliente (chave: telefone)
app.post('/api/clientes', h(async (req, res) => {
  const c = req.body || {};
  const telefone = String(c.telefone || '').replace(/\D/g, '');
  if (!c.nome || telefone.length < 10) return res.status(400).json({ erro: 'Nome e telefone válidos são obrigatórios' });
  const row = await q1(`INSERT INTO clientes(nome,telefone,email,cep,logradouro,numero,bairro,cidade,uf)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(telefone) DO UPDATE SET nome=EXCLUDED.nome, email=EXCLUDED.email, cep=EXCLUDED.cep,
      logradouro=EXCLUDED.logradouro, numero=EXCLUDED.numero, bairro=EXCLUDED.bairro,
      cidade=EXCLUDED.cidade, uf=EXCLUDED.uf RETURNING *`,
    [c.nome, telefone, c.email || null, c.cep || null, c.logradouro || null, c.numero || null,
     c.bairro || null, c.cidade || null, c.uf || null]);
  res.json(row);
}));

app.get('/api/disponibilidade', h(async (req, res) => {
  const { profissional_id, servico_id, data } = req.query;
  res.json(await livres(profissional_id, servico_id, data));
}));

app.post('/api/agendamentos', h(async (req, res) => {
  let id;
  try { id = await criarAgendamento(req.body); } catch (e) { return res.status(409).json({ erro: e.message }); }
  const b = req.body;
  await q("UPDATE lista_espera SET status='atendido' WHERE cliente_id=$1 AND servico_id=$2 AND data=$3 AND status!='atendido'",
    [b.cliente_id, b.servico_id, b.data]);
  const a = await detalhe(id);
  await enviar(a.cliente_id, id, 'confirmacao',
    `Olá ${a.cliente}! Agendamento confirmado: ${a.servico} com ${a.profissional} em ${br(a.inicio)}.`);
  res.status(201).json(a);
}));

app.get('/api/clientes/:id/agendamentos', h(async (req, res) => res.json(await q(`
  SELECT a.id, a.inicio, a.status, p.nome AS profissional, s.nome AS servico
  FROM agendamentos a JOIN profissionais p ON p.id=a.profissional_id JOIN servicos s ON s.id=a.servico_id
  WHERE a.cliente_id=$1 AND a.status='agendado' AND a.inicio >= $2
  ORDER BY a.inicio`, [req.params.id, stamp(new Date(Date.now() - 3600e3))]))));

app.delete('/api/agendamentos/:id', h(async (req, res) => {
  const a = await detalhe(req.params.id);
  if (!a || a.status !== 'agendado') return res.status(404).json({ erro: 'Agendamento não encontrado' });
  await q("UPDATE agendamentos SET status='cancelado' WHERE id=$1", [a.id]);
  await enviar(a.cliente_id, a.id, 'cancelamento', `Seu agendamento de ${a.servico} em ${br(a.inicio)} foi cancelado.`);
  await avisarEspera(a);
  res.json({ ok: true });
}));

app.post('/api/espera', h(async (req, res) => {
  const { cliente_id, profissional_id, servico_id, data } = req.body;
  if (!cliente_id || !servico_id || !data) return res.status(400).json({ erro: 'Dados incompletos' });
  await q('INSERT INTO lista_espera(cliente_id,profissional_id,servico_id,data) VALUES ($1,$2,$3,$4)',
    [cliente_id, profissional_id || null, servico_id, data]);
  res.status(201).json({ ok: true });
}));

// Painel da barbearia
app.get('/api/admin/agenda', h(async (req, res) => res.json(await q(`
  SELECT a.id, a.inicio, a.fim, c.nome AS cliente, c.telefone, p.nome AS profissional, s.nome AS servico
  FROM agendamentos a JOIN clientes c ON c.id=a.cliente_id JOIN profissionais p ON p.id=a.profissional_id
  JOIN servicos s ON s.id=a.servico_id
  WHERE a.status='agendado' AND substr(a.inicio,1,10)=$1 ORDER BY a.inicio`, [req.query.data]))));
app.get('/api/admin/mensagens', h(async (_req, res) => res.json(await q(`
  SELECT m.id, m.tipo, m.conteudo, c.nome AS cliente FROM mensagens m JOIN clientes c ON c.id=m.cliente_id
  ORDER BY m.id DESC LIMIT 30`))));

// ---------- lembrete 2h antes (roda a cada minuto) ----------
// Agendamentos feitos com menos de 2h de antecedência recebem o lembrete no próximo ciclo.
let rodando = false;
setInterval(async () => {
  if (rodando) return; rodando = true;
  try {
    const agora = Date.now();
    for (const { id } of await q("SELECT id FROM agendamentos WHERE status='agendado' AND lembrete_enviado=0")) {
      const a = await detalhe(id), falta = parse(a.inicio) - agora;
      if (falta > 0 && falta <= 2 * 3600e3) {
        await enviar(a.cliente_id, id, 'lembrete', `Lembrete: ${a.servico} com ${a.profissional} hoje às ${a.inicio.slice(11)}. Te esperamos!`);
        await q('UPDATE agendamentos SET lembrete_enviado=1 WHERE id=$1', [id]);
      }
    }
  } catch (e) { console.error('lembretes:', e.message); } finally { rodando = false; }
}, 60e3);

init().then(() => app.listen(process.env.PORT || 3000, () => console.log('BarberFlow no ar')))
  .catch(e => { console.error('Falha ao iniciar:', e); process.exit(1); });
