'use strict';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const { parse } = require('csv-parse/sync');

// ─────────────────────────────────────────────
//  CONFIGURAÇÕES — edite aqui antes de rodar
// ─────────────────────────────────────────────

/**
 * Lista de mensagens — uma será escolhida aleatoriamente para cada contato.
 * Adicione ou edite quantas quiser.
 */
const MENSAGENS = [
  `Olá! Tudo bem?

Me chamo Ramirez Stwart e sou o corretor responsável pelo Residencial Santo Agostinho.

Estou entrando em contato para me apresentar e também para entender se você tem interesse em conhecer as novas oportunidades de lotes e imóveis disponíveis no residencial.

Será um prazer apresentar as opções disponíveis e tirar qualquer dúvida que você tenha.`,

  `Oi, tudo bem?

Meu nome é Ramirez Stwart, sou corretor de imóveis e trabalho com o Residencial Santo Agostinho.

Vim aqui para me apresentar e ver se você teria interesse em conhecer as oportunidades de lotes e imóveis que temos disponíveis por lá.

Fico à disposição para conversar e apresentar tudo com calma!`,

  `Olá! Como vai?

Sou o Ramirez Stwart, corretor responsável pelo Residencial Santo Agostinho, e gostaria de me apresentar.

Temos ótimas opções de lotes e imóveis disponíveis e adoraria te mostrar o que temos. Se tiver interesse, é só me chamar!`,
];

/** Caminho para o arquivo CSV com a lista de clientes */
const ARQUIVO_CSV = './clientes.csv';

/**
 * Intervalos de espera entre envios (em milissegundos).
 * O script sorteia aleatoriamente entre curto, médio e longo
 * para simular comportamento humano.
 */
const INTERVALOS_MS = [
  { min: 8000,  max: 15000 },  // curto:  8–15 segundos
  { min: 15000, max: 30000 },  // médio:  15–30 segundos
  { min: 30000, max: 60000 },  // longo:  30–60 segundos
];

// Pesos de sorteio: 50% curto, 30% médio, 20% longo
const PESOS_INTERVALO = [50, 30, 20];

// ─────────────────────────────────────────────
//  FUNÇÕES AUXILIARES
// ─────────────────────────────────────────────

/** Retorna um número inteiro aleatório entre min e max (inclusivo) */
function sorteioInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Aguarda um tempo aleatório entre min e max ms */
function espera(min, max) {
  const ms = sorteioInt(min, max);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Escolhe um índice aleatório ponderado pelos pesos fornecidos */
function sorteioComPeso(pesos) {
  const total = pesos.reduce((a, b) => a + b, 0);
  let rand = sorteioInt(1, total);
  for (let i = 0; i < pesos.length; i++) {
    rand -= pesos[i];
    if (rand <= 0) return i;
  }
  return pesos.length - 1;
}

/** Retorna uma mensagem aleatória da lista */
function sortearMensagem() {
  return MENSAGENS[sorteioInt(0, MENSAGENS.length - 1)];
}

/** Retorna um intervalo aleatório ponderado e aguarda esse tempo, exibindo o countdown */
async function aguardarIntervalo() {
  const idx = sorteioComPeso(PESOS_INTERVALO);
  const { min, max } = INTERVALOS_MS[idx];
  const ms = sorteioInt(min, max);
  let restante = Math.round(ms / 1000);

  await new Promise((resolve) => {
    const tick = setInterval(() => {
      process.stdout.write(`\r[AGUARDANDO] Próximo envio em ${restante}s...   `);
      restante--;
      if (restante < 0) {
        clearInterval(tick);
        process.stdout.write('\r' + ' '.repeat(50) + '\r'); // limpa a linha
        resolve();
      }
    }, 1000);
  });
}

/**
 * Normaliza o número de telefone para o formato aceito pelo WhatsApp:
 * código do país + DDD + número, sem espaços, traços ou parênteses.
 * Exemplo: "(11) 91234-5678"  →  "5511912345678@c.us"
 */
function normalizarTelefone(telefone) {
  // Remove tudo que não for dígito
  let numero = String(telefone).replace(/\D/g, '');

  // Se não começar com o código do Brasil (55), adiciona
  if (!numero.startsWith('55')) {
    numero = '55' + numero;
  }

  return `${numero}@c.us`;
}

/**
 * Detecta se o CSV está no formato esperado (Nome, Telefone com vírgula).
 * Se não estiver, identifica automaticamente as colunas e reescreve o arquivo.
 */
function normalizarCSV(caminho) {
  if (!fs.existsSync(caminho)) return; // lerClientes vai tratar o erro

  const conteudo = fs.readFileSync(caminho, 'utf8').trim();
  const linhas = conteudo.split(/\r?\n/).filter((l) => l.trim() !== '');

  if (linhas.length === 0) return;

  // Detecta delimitador: tab ou vírgula
  const delimitador = linhas[0].includes('\t') ? '\t' : ',';

  const colunas = linhas[0].split(delimitador).map((c) => c.trim().replace(/^"|"$/g, ''));

  // Já está no formato correto?
  if (colunas[0] === 'Nome' && colunas[1] === 'Telefone' && delimitador === ',') {
    return;
  }

  console.log('[INFO] CSV em formato diferente detectado. Normalizando...');

  // Heurística: se a primeira linha contém campo sem dígitos, é cabeçalho
  const primeiraLinhaEhCabecalho = colunas.some((c) => /^[^\d]+$/.test(c));
  const inicio = primeiraLinhaEhCabecalho ? 1 : 0;
  const dadosLinhas = linhas.slice(inicio);

  if (dadosLinhas.length === 0) {
    console.warn('[AVISO] CSV sem dados após o cabeçalho. Nada a normalizar.');
    return;
  }

  // Usa a primeira linha de dados para detectar qual coluna é o telefone
  const amostra = dadosLinhas[0].split(delimitador).map((c) => c.trim().replace(/^"|"$/g, ''));

  function pareceTelefone(valor) {
    return /^[\d\s\-\(\)\+]+$/.test(valor) && valor.replace(/\D/g, '').length >= 8;
  }

  let idxNome = -1;
  let idxTelefone = -1;

  for (let i = 0; i < amostra.length; i++) {
    if (pareceTelefone(amostra[i])) {
      idxTelefone = i;
    } else if (idxNome === -1) {
      idxNome = i;
    }
  }

  // Fallback: assume col 0 = nome, col 1 = telefone
  if (idxNome === -1) idxNome = 0;
  if (idxTelefone === -1) idxTelefone = 1;

  // Reconstrói o CSV no formato correto
  const novasLinhas = ['Nome,Telefone'];
  for (const linha of dadosLinhas) {
    const partes = linha.split(delimitador).map((c) => c.trim().replace(/^"|"$/g, ''));
    const nome = partes[idxNome] || '';
    const tel = partes[idxTelefone] || '';
    if (!nome && !tel) continue;
    const nomeFmt = nome.includes(',') ? `"${nome}"` : nome;
    novasLinhas.push(`${nomeFmt},${tel}`);
  }

  fs.writeFileSync(caminho, novasLinhas.join('\n'), 'utf8');
  console.log(`[INFO] CSV normalizado com sucesso! ${dadosLinhas.length} registro(s) ajustado(s) → formato Nome,Telefone.\n`);
}

/** Lê e parseia o CSV de clientes */
function lerClientes(caminho) {
  if (!fs.existsSync(caminho)) {
    console.error(`[ERRO] Arquivo não encontrado: ${caminho}`);
    process.exit(1);
  }

  const conteudo = fs.readFileSync(caminho, 'utf8');

  const registros = parse(conteudo, {
    columns: true,           // usa a primeira linha como cabeçalho
    skip_empty_lines: true,
    trim: true,
  });

  // Valida se as colunas obrigatórias existem
  if (registros.length === 0) {
    console.error('[ERRO] O arquivo CSV está vazio.');
    process.exit(1);
  }

  const colunas = Object.keys(registros[0]);
  if (!colunas.includes('Nome') || !colunas.includes('Telefone')) {
    console.error('[ERRO] O CSV deve ter as colunas "Nome" e "Telefone".');
    console.error(`Colunas encontradas: ${colunas.join(', ')}`);
    process.exit(1);
  }

  return registros;
}

// ─────────────────────────────────────────────
//  INICIALIZAÇÃO DO CLIENT WHATSAPP
// ─────────────────────────────────────────────

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wpp_session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('\n[INFO] Escaneie o QR Code abaixo com o WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('[INFO] Autenticado com sucesso!');
});

client.on('auth_failure', (msg) => {
  console.error('[ERRO] Falha na autenticação:', msg);
  process.exit(1);
});

client.on('ready', async () => {
  console.log('[INFO] WhatsApp Web conectado e pronto!\n');

  normalizarCSV(ARQUIVO_CSV);
  const clientes = lerClientes(ARQUIVO_CSV);
  console.log(`[INFO] ${clientes.length} cliente(s) encontrado(s) no CSV.\n`);

  let enviados = 0;
  const listFalhas = []; // { Nome, Telefone, motivo }

  for (let i = 0; i < clientes.length; i++) {
    const { Nome, Telefone } = clientes[i];
    const chatId = normalizarTelefone(Telefone);

    try {
      // Verifica se o número existe no WhatsApp antes de enviar
      const numeroRegistrado = await client.isRegisteredUser(chatId);

      if (!numeroRegistrado) {
        console.warn(`[AVISO] (${i + 1}/${clientes.length}) ${Nome} — número ${Telefone} não encontrado no WhatsApp. Pulando.`);
        listFalhas.push({ Nome, Telefone, motivo: 'Número não encontrado no WhatsApp' });
      } else {
        const mensagem = sortearMensagem();
        await client.sendMessage(chatId, mensagem);
        console.log(`[OK]    (${i + 1}/${clientes.length}) Mensagem enviada para ${Nome} (${Telefone})`);
        enviados++;
      }
    } catch (err) {
      console.error(`[ERRO]  (${i + 1}/${clientes.length}) Falha ao enviar para ${Nome} (${Telefone}): ${err.message}`);
      listFalhas.push({ Nome, Telefone, motivo: err.message });
    }

    // Aguarda intervalo aleatório antes do próximo envio (exceto no último)
    if (i < clientes.length - 1) {
      await aguardarIntervalo();
    }
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`  RESUMO FINAL`);
  console.log(`─────────────────────────────────────────────`);
  console.log(`  Enviados com sucesso : ${enviados}`);
  console.log(`  Falhas / Pulados     : ${listFalhas.length}`);
  console.log(`─────────────────────────────────────────────`);

  if (listFalhas.length > 0) {
    console.log('\n  CONTATOS QUE FALHARAM:\n');
    listFalhas.forEach((f, idx) => {
      console.log(`  ${idx + 1}. ${f.Nome}`);
      console.log(`     Telefone : ${f.Telefone}`);
      console.log(`     Motivo   : ${f.motivo}\n`);
    });
  }

  console.log('─────────────────────────────────────────────\n');

  // Aguarda 8 segundos para garantir que todas as mensagens foram transmitidas
  // ao servidor do WhatsApp antes de encerrar a conexão
  console.log('[INFO] Aguardando transmissão final das mensagens...');
  await espera(8000, 8000);

  await client.destroy();
  process.exit(0);
});

client.initialize();
