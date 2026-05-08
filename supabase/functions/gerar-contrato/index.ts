// Soter — Edge Function: gerar-contrato
// Motor de geração de contratos em TypeScript (migrado de Python)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unzipSync, zipSync, strToU8, strFromU8 } from "npm:fflate";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TAXA_COMISSAO = 0.043;

// ─── TIPOS ───────────────────────────────────────────────────────────────────

interface Comprador {
  nome: string;
  cpf: string;
  sexo?: string;
  nacionalidade?: string;
  profissao?: string;
  estado_civil?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
}

interface Parcela {
  tipo: string;
  qtd?: number;
  valor: number;
  data?: string;
  reajustavel?: boolean;
}

interface Corretor {
  nome: string;
  creci?: string;
  cpf_cnpj?: string;
  valor?: number;
}

interface Imobiliaria {
  empresa?: string;
  nome?: string;
}

interface ContratoRequest {
  compradores: Comprador[];
  relacao?: string;
  regime_bens?: string;
  data_escritura?: string;
  endereco?: string;
  telefone?: string;
  email?: string;
  sigla?: string;
  unidade?: string;
  fracao_ideal?: string;
  vagas?: string;
  parcelas_diretas?: Parcela[];
  preco_direto?: number;
  fluxo?: string;
  valor_venda_manual?: number;
  data_assinatura?: string;
  tipo_ass?: string;
  corretores?: Corretor[];
  imobiliarias?: Imobiliaria[];
  parcela_desconto_manual?: string;
}

// ─── EMPREENDIMENTOS ─────────────────────────────────────────────────────────
// Siglas válidas. Basta adicionar a sigla aqui e subir os 4 arquivos no Storage
// seguindo o padrão: "[SIGLA] contrato_cabeca.docx", "[SIGLA] corpo_cabeca.docx",
//                    "[SIGLA] contrato_faturado.docx", "[SIGLA] corpo_faturado.docx"
//
// Exceções: empreendimentos que usam nome diferente da sigla no arquivo
const NOME_ARQUIVO: Record<string, string> = {
  DMS: "Clarice",   // ex: "Clarice contrato_cabeca.docx"
  // Se os demais usarem a própria sigla, não precisa adicionar aqui
};

const SIGLAS_ATIVAS = new Set([
  "DMS",  // Clarice
  "AAZ",  // Origem
  "BAK",  // Attrium Icaraí
  "BCO",  // Ion Icaraí
  "H23",  // Maestro
  "SMK",  // Pulse
]);

function getTemplates(sigla: string, tipo: string) {
  const s = sigla?.toUpperCase();
  if (!SIGLAS_ATIVAS.has(s)) {
    throw new Error(`Empreendimento não reconhecido: ${sigla}`);
  }
  const prefixo = NOME_ARQUIVO[s] || s;
  return tipo === "destacada"
    ? { contrato: `${prefixo} contrato_cabeca.docx`,  corpo: `${prefixo} corpo_cabeca.docx`  }
    : { contrato: `${prefixo} contrato_faturado.docx`, corpo: `${prefixo} corpo_faturado.docx` };
}

// ─── FORMATAÇÃO ──────────────────────────────────────────────────────────────

function formatar(valor: number): string {
  // Implementação manual — toLocaleString não é confiável no Deno
  const fixed = valor.toFixed(2);
  const [intPart, decPart] = fixed.split(".");
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return intFormatted + "," + decPart;
}

function formatarPercentual(valor: number): string {
  return valor.toFixed(2).replace(".", ",") + "%";
}

function extenso(valor: number): string {
  const un = ["","um","dois","três","quatro","cinco","seis","sete","oito","nove",
              "dez","onze","doze","treze","quatorze","quinze","dezesseis","dezessete","dezoito","dezenove"];
  const dz = ["","","vinte","trinta","quarenta","cinquenta","sessenta","setenta","oitenta","noventa"];
  const ct = ["","cento","duzentos","trezentos","quatrocentos","quinhentos",
              "seiscentos","setecentos","oitocentos","novecentos"];

  function grupo(n: number): string {
    if (n === 0)   return "";
    if (n === 100) return "cem";
    const c = Math.floor(n / 100), r = n % 100;
    const cent = c > 0 ? ct[c] : "";
    let resto = "";
    if (r > 0) {
      if (r < 20)         resto = un[r];
      else { const d = Math.floor(r/10), u = r%10; resto = dz[d] + (u ? " e " + un[u] : ""); }
    }
    return cent + (cent && resto ? " e " : "") + resto;
  }

  const inteiro = Math.floor(valor);
  const ctvs    = Math.round((valor - inteiro) * 100);

  let r = "";
  if (inteiro === 0) {
    r = "zero";
  } else {
    const milh = Math.floor(inteiro / 1_000_000);
    const mil  = Math.floor((inteiro % 1_000_000) / 1_000);
    const res  = inteiro % 1_000;
    const partes: string[] = [];
    if (milh) partes.push(grupo(milh) + (milh === 1 ? " milhão" : " milhões"));
    if (mil)  partes.push(mil === 1 ? "mil" : grupo(mil) + " mil");
    if (res)  partes.push(grupo(res));
    r = partes.join(" e ") + (inteiro === 1 ? " real" : " reais");
  }
  if (ctvs > 0) r += " e " + grupo(ctvs) + (ctvs === 1 ? " centavo" : " centavos");
  return r;
}

// ─── COMISSÃO ────────────────────────────────────────────────────────────────

function definirTipoComissao(preco: number, sinal: number, p30 = 0, p60 = 0) {
  if (!preco || preco <= 0) {
    return { tipo: "faturada", total_comissao: 0, parcela_desconto: null };
  }
  const comissao = Math.round(preco * TAXA_COMISSAO * 100) / 100;
  const limiar   = preco * 0.10;

  let tipo: string;
  let parcela_desconto: string | null;

  if (sinal >= limiar)               { tipo = "destacada"; parcela_desconto = "ato"; }
  else if (sinal + p30 >= limiar)    { tipo = "destacada"; parcela_desconto = "complemento_30"; }
  else if (sinal + p30 + p60 >= limiar) { tipo = "destacada"; parcela_desconto = "complemento_60"; }
  else                               { tipo = "faturada";  parcela_desconto = null; }

  return { tipo, total_comissao: comissao, parcela_desconto };
}

// ─── FLUXO TEXTO LIVRE ───────────────────────────────────────────────────────

function interpretarFluxo(texto: string): { parcelas: Parcela[]; valor_venda: number } {
  const parcelas: Parcela[] = [];
  let valor_venda = 0;

  // Suporta separador \n ou |
  const linhas = (texto || "").split(/\n|\|/).map(l => l.trim()).filter(Boolean);

  for (const l of linhas) {
    const ll = l.toLowerCase();

    // Detecta valor de venda (aceita "venda:", "valor de venda", "valor venda")
    if (ll.match(/\bvenda\b/) && !ll.includes("ato") && !ll.includes("mensai") && !ll.includes("semestrai") && !ll.includes("anua")) {
      const v = l.match(/R\$\s*([\d\.,]+)/) || l.match(/:\s*([\d\.,]+)/);
      if (v) valor_venda = parseFloat(v[1].replace(/\./g, "").replace(",", "."));
      continue;
    }

    // Extrai quantidade: aceita (60), 60x, x60
    const qtdMatch = l.match(/\((\d+)\)/) || l.match(/\b(\d+)\s*x\b/i) || l.match(/\bx\s*(\d+)\b/i);
    const qtd = qtdMatch ? parseInt(qtdMatch[1]) : 1;

    // Extrai valor monetário: prefere R$ valor, fallback para : valor
    const valorMoneyMatch = l.match(/R\$\s*([\d\.,]+)/);
    const valorColonMatch = l.match(/:\s*([\d\.,]+)/);
    const valorRaw = valorMoneyMatch
      ? valorMoneyMatch[1]
      : (valorColonMatch ? valorColonMatch[1] : null);
    const valor = valorRaw ? parseFloat(valorRaw.replace(/\./g, "").replace(",", ".")) : 0;

    // Extrai data
    const dataMatch = l.match(/(\d{2}\/\d{2}\/\d{4})/);
    const data = dataMatch ? dataMatch[1] : "";

    // Classifica tipo
    let tipo: string;
    if      (ll.match(/\bato\b/))                                  tipo = "ato";
    else if (ll.includes("complemento"))                           tipo = "complemento";
    else if (ll.match(/\b30d\b|\b60d\b|\b90d\b/))                 tipo = "complemento";
    else if (ll.includes("mensai"))                                tipo = "mensal";
    else if (ll.includes("semestrai"))                             tipo = "semestral";
    else if (ll.includes("anua"))                                  tipo = "anual";
    else if (ll.includes("financiamento"))                         tipo = "financiamento";
    else if (ll.includes("única") || ll.includes("unica"))         tipo = "unica";
    else continue;

    parcelas.push({ tipo, qtd, valor, data, reajustavel: true });
  }

  return { parcelas, valor_venda };
}

// ─── PAGAMENTO ───────────────────────────────────────────────────────────────

function romano(n: number): string {
  const r = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
  return n < r.length ? r[n] : String(n);
}

function linhasPagamento(parcelas: Parcela[]): string[] {
  // Retorna uma linha de texto por parcela (sem prefixo romano — o template já é lista numerada)
  const textos: string[] = [];

  for (const p of parcelas) {
    if (p.tipo === "ato") continue;
    const qtd       = p.qtd || 1;
    const total     = p.valor * qtd;
    const valorUnit = formatar(p.valor);
    const valorTot  = formatar(total);
    const data      = p.data || "";
    const reaj      = p.reajustavel !== false ? "reajustável" : "fixo";

    if (p.tipo === "financiamento" || p.tipo === "unica") {
      const label = p.tipo === "financiamento" ? "Parcela de Financiamento" : "Parcela Única";
      textos.push(
        `R$${valorUnit} (${extenso(p.valor)}) serão pagos em uma única ` +
        `parcela ${reaj} com vencimento em ${data} ("${label}");`
      );
      continue;
    }

    let descricao: string, period: string;
    if      (p.tipo === "mensal")      { descricao = "Parcelas Mensais";                 period = "mensais"; }
    else if (p.tipo === "anual")       { descricao = "Parcelas Anuais";                  period = "anuais"; }
    else if (p.tipo === "semestral")   { descricao = "Parcelas Semestrais";              period = "semestrais"; }
    else if (p.tipo === "complemento") { descricao = "Parcelas de Complemento de Sinal"; period = "mensais"; }
    else                               { descricao = "Parcelas";                          period = "mensais"; }

    textos.push(
      `R$${valorTot} (${extenso(total)}) serão pagos em ${qtd} parcelas ` +
      `${reaj}s, ${period}, sucessivas, no valor de R$${valorUnit} (${extenso(p.valor)}) ` +
      `cada uma delas, vencendo-se a primeira no dia ${data} e as demais no mesmo dia dos ` +
      `${period} subsequentes ("${descricao}");`
    );
  }
  return textos;
}

// substituirPagamento: substitui o parágrafo «PAGAMENTO» por N parágrafos (um por parcela)
function substituirPagamento(xml: string, parcelas: Parcela[]): string {
  const linhas = linhasPagamento(parcelas);
  const idx    = xml.indexOf("«PAGAMENTO»");
  if (idx === -1) return xml;

  // Localiza o <w:p> ou <w:p  que contém o placeholder (não pega <w:pPr>)
  let pStart = -1;
  let searchPos2 = idx;
  while (searchPos2 > 0) {
    const candidate = xml.lastIndexOf("<w:p", searchPos2);
    if (candidate === -1) break;
    const charAfter = xml[candidate + 4];
    if (charAfter === ">" || charAfter === " ") { pStart = candidate; break; }
    searchPos2 = candidate - 1;
  }
  const pEnd = xml.indexOf("</w:p>", idx) + "</w:p>".length;
  if (pStart === -1 || pEnd < idx) return xml;

  const paraOrig = xml.substring(pStart, pEnd);

  // Extrai <w:pPr> para reutilizar em cada novo parágrafo
  const pPrMatch = paraOrig.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/);
  const pPr      = pPrMatch ? pPrMatch[0] : "";

  // Extrai <w:rPr> do run original para manter fonte
  const rPrMatch = paraOrig.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/);
  const rPr      = rPrMatch ? rPrMatch[0] : "";

  if (linhas.length === 0) {
    // Sem parcelas: remove o parágrafo inteiro
    return xml.substring(0, pStart) + xml.substring(pEnd);
  }

  // Adiciona espaçamento após cada parágrafo para separação visual entre itens
  let pPrComEspaco = pPr;
  if (pPr) {
    if (pPr.includes("<w:spacing")) {
      // Insere w:after se não existir
      pPrComEspaco = pPr.replace(/<w:spacing([^/]*?)\/>/, (m, attrs) =>
        attrs.includes("w:after=") ? m : `<w:spacing${attrs} w:after="160"/>`
      );
    } else {
      pPrComEspaco = pPr.replace("</w:pPr>", '<w:spacing w:after="160"/></w:pPr>');
    }
  }

  // Gera um parágrafo por linha de pagamento
  const parasNovos = linhas.map(t =>
    `<w:p>${pPrComEspaco}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(t)}</w:t></w:r></w:p>`
  ).join("");

  return xml.substring(0, pStart) + parasNovos + xml.substring(pEnd);
}

// substituirComunicacao: substitui o run «COMUNICACAO» por run com quebras de linha XML
function substituirComunicacao(xml: string, dados: ContratoRequest): string {
  const idx = xml.indexOf("«COMUNICACAO»");
  if (idx === -1) return xml;

  // Localiza o <w:r> ou <w:r  (com atributos) que contém o placeholder
  // Importante: NÃO pode pegar <w:rPr> — por isso validamos o char após "<w:r"
  let rStart = -1;
  let searchPos = idx;
  while (searchPos > 0) {
    const candidate = xml.lastIndexOf("<w:r", searchPos);
    if (candidate === -1) break;
    const charAfter = xml[candidate + 4];
    if (charAfter === ">" || charAfter === " ") { rStart = candidate; break; }
    searchPos = candidate - 1;
  }

  const rEnd = xml.indexOf("</w:r>", idx) + "</w:r>".length;
  if (rStart === -1 || rEnd < idx) return xml.replaceAll("«COMUNICACAO»", "");

  const runOrig  = xml.substring(rStart, rEnd);
  const rPrMatch = runOrig.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/);
  const rPr      = rPrMatch ? rPrMatch[0] : "";

  const linhas: string[] = [];
  if (dados.compradores[0]?.nome) linhas.push(`At.: ${escapeXml(dados.compradores[0].nome)}`);
  if (dados.endereco)              linhas.push(`End.: ${escapeXml(dados.endereco)}`);
  if (dados.telefone)              linhas.push(`Tel.: ${escapeXml(dados.telefone)}`);
  if (dados.email)                 linhas.push(`E-mail: ${escapeXml(dados.email)}`);

  if (linhas.length === 0) return xml.substring(0, rStart) + xml.substring(rEnd);

  // Monta o run com <w:t> e <w:br/> intercalados
  const inner = linhas.map((l, i) =>
    `<w:t xml:space="preserve">${l}</w:t>${i < linhas.length - 1 ? "<w:br/>" : ""}`
  ).join("");

  const novoRun = `<w:r>${rPr}${inner}</w:r>`;
  let resultado = xml.substring(0, rStart) + novoRun + xml.substring(rEnd);

  // Força alinhamento esquerdo no <w:p> pai para evitar texto espalhado por justificação
  const pIdxAntes = resultado.lastIndexOf("<w:p", rStart);
  const pFimTag   = resultado.indexOf(">", pIdxAntes);
  const pFimEl    = resultado.indexOf("</w:p>", rStart) + "</w:p>".length;
  if (pIdxAntes !== -1 && pFimEl > rStart) {
    const paraBloco = resultado.substring(pIdxAntes, pFimEl);
    // Remove <w:jc> existente e adiciona w:jc left dentro do pPr
    let paraFixed = paraBloco.replace(/<w:jc[^/]*\/>/g, "");
    paraFixed = paraFixed.replace("</w:pPr>", '<w:jc w:val="left"/></w:pPr>');
    resultado = resultado.substring(0, pIdxAntes) + paraFixed + resultado.substring(pFimEl);
  }

  return resultado;
}

// ─── COMPRADORA ──────────────────────────────────────────────────────────────

function qualificar(c: Comprador): string {
  const inscrito = (c.sexo || "M") === "M" ? "inscrito" : "inscrita";
  const rgPart   = c.rg ? `, RG nº ${c.rg} expedido pelo ${c.orgao_emissor || ""}` : "";
  return (
    `${c.nome}, ${(c.nacionalidade || "brasileiro(a)").toLowerCase()}, ` +
    `${c.profissao || ""}, ${inscrito} no CPF/ME sob o nº ${c.cpf}${rgPart}`
  );
}

function montarCompradora(dados: ContratoRequest): string {
  const compradores = dados.compradores;
  const relacao     = dados.relacao || "solteiro / independentes";
  const regime      = dados.regime_bens || "";
  const endereco    = dados.endereco || "";

  if (compradores.length === 1) {
    return `${qualificar(compradores[0])}, residente(s) na ${endereco}`;
  }

  const [c1, c2] = compradores;

  if (relacao === "casado") {
    const conj = (c2.sexo || "F") === "F" ? "sua esposa" : "seu esposo";
    return (
      `${qualificar(c1)}, e ${conj} ${qualificar(c2)}, ` +
      `casados pelo regime de ${regime}, residentes na ${endereco}`
    );
  }

  if (relacao === "união estável") {
    const dataPart = dados.data_escritura ? ` desde ${dados.data_escritura}` : "";
    return (
      `${qualificar(c1)}, e ${qualificar(c2)}, ` +
      `companheiros em união estável${dataPart}, residentes na ${endereco}`
    );
  }

  return `${qualificar(c1)}, e ${qualificar(c2)}, residentes na ${endereco}`;
}

// ─── DOCX: SUBSTITUIÇÃO E MERGE ──────────────────────────────────────────────

function substituirCorretores(xml: string, corretores: Corretor[]): string {
  const total = corretores.reduce((sum, c) => sum + (c.valor || 0), 0);

  // Localiza a linha modelo «CORRETOR_EMPRESA» no template
  const marker = "«CORRETOR_EMPRESA»";
  const idx = xml.indexOf(marker);

  if (idx === -1) {
    // Template sem tabela de corretores (ex: faturado simples)
    return xml.replaceAll("«TOTAL_COMISSAO»", formatar(total));
  }

  // Extrai o <w:tr> completo que contém o marcador
  const trStart = xml.lastIndexOf("<w:tr", idx);
  const trEnd   = xml.indexOf("</w:tr>", idx) + "</w:tr>".length;
  if (trStart === -1 || trEnd === -1) {
    return xml.replaceAll("«TOTAL_COMISSAO»", formatar(total));
  }

  const rowModelo = xml.substring(trStart, trEnd);

  // Normaliza rPr da linha modelo: remove sz/szCs e rFonts explícitos e força centralização
  let rowNorm = rowModelo
    .replace(/<w:sz\b[^>]*\/>/g, "")
    .replace(/<w:szCs\b[^>]*\/>/g, "")
    .replace(/<w:rFonts\b[^>]*\/>/g, "");

  // Substitui qualquer jc existente por center; depois adiciona center em pPr sem jc
  rowNorm = rowNorm.replace(/<w:jc\b[^>]*\/>/g, '<w:jc w:val="center"/>');
  rowNorm = rowNorm.replace(/(<w:pPr>)([\s\S]*?)(<\/w:pPr>)/g, (m, open, content, close) =>
    content.includes("<w:jc ") ? m : open + content + '<w:jc w:val="center"/>' + close
  );
  // Força Calibri 12pt em todos os runs da linha
  const fonteCalibri = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:szCs w:val="24"/>';
  rowNorm = rowNorm.replace(/(<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g, (m, open, content, close) =>
    open + content + fonteCalibri + close
  );
  // Runs sem rPr: insere rPr com Calibri 12pt antes de <w:t>
  rowNorm = rowNorm.replace(/(<w:r\b[^>]*>)(?![\s\S]{0,50}<w:rPr)(<w:t)/g,
    `$1<w:rPr>${fonteCalibri}</w:rPr>$2`
  );

  // Gera uma linha por corretor (sem limite fixo)
  const linhas = corretores.map(c =>
    rowNorm
      .replaceAll("«CORRETOR_EMPRESA»",  escapeXml(c.nome      || ""))
      .replaceAll("«CORRETOR_CRECI»",    escapeXml(c.creci     || ""))
      .replaceAll("«CORRETOR_CPFCNPJ»",  escapeXml(c.cpf_cnpj  || ""))
      .replaceAll("«CORRETOR_VALOR»",    c.valor != null ? formatar(c.valor) : "")
  ).join("");

  // Substitui a linha modelo pelo bloco gerado + TOTAL_COMISSAO
  let resultado = (xml.substring(0, trStart) + linhas + xml.substring(trEnd))
    .replaceAll("«TOTAL_COMISSAO»", formatar(total));

  // Remove run com ",00" hardcoded que alguns templates têm logo após «TOTAL_COMISSAO».
  // Itera TODAS as ocorrências porque CORRETOR_VALOR e TOTAL_COMISSAO podem ter o mesmo
  // valor formatado — a linha de corretor não tem ,00 após o valor, só a linha TOTAL tem.
  const totalStr = formatar(total);
  const searchStr = totalStr + "</w:t>";
  let pos = 0;
  while (true) {
    const found = resultado.indexOf(searchStr, pos);
    if (found === -1) break;
    const ahead = resultado.substring(found, found + 600);
    const fixed = ahead.replace(
      /<w:r\b[^>]*>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t[^>]*>\s*,00\s*<\/w:t><\/w:r>/,
      ""
    );
    if (fixed !== ahead) {
      resultado = resultado.substring(0, found) + fixed + resultado.substring(found + 600);
      break;
    }
    pos = found + 1;
  }

  return resultado;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function substituir(xml: string, subs: Record<string, string>): string {
  let result = xml;
  for (const [placeholder, valor] of Object.entries(subs)) {
    const safe = escapeXml(valor);
    // Substituição simples — funciona quando o placeholder está num único run
    let prev = "";
    while (prev !== result) {
      prev   = result;
      result = result.replace(placeholder, safe);
    }
  }
  return result;
}

function mesclarDocs(xml1: string, xml2: string): string {
  // Extrai conteúdo do body do doc2 sem o sectPr
  const bodyMatch = xml2.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) return xml1;
  const corpo2 = bodyMatch[1].replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g, "");

  // Localiza o body-level sectPr do doc1 via indexOf (evita problemas com $ no regex replace)
  const bodyCloseIdx = xml1.lastIndexOf("</w:body>");
  if (bodyCloseIdx === -1) return xml1;

  const BODY_CLOSE = "</w:body>";
  const bodyContent = xml1.substring(0, bodyCloseIdx);
  const suffix = xml1.substring(bodyCloseIdx + BODY_CLOSE.length); // "</w:document>" etc.

  const lastSectPrIdx = bodyContent.lastIndexOf("<w:sectPr");
  if (lastSectPrIdx === -1) {
    return bodyContent + corpo2 + BODY_CLOSE + suffix;
  }

  const sectPrEndTag = "</w:sectPr>";
  const sectPrEndIdx = bodyContent.indexOf(sectPrEndTag, lastSectPrIdx);
  if (sectPrEndIdx === -1) {
    return bodyContent + corpo2 + BODY_CLOSE + suffix;
  }

  const beforeSectPr = bodyContent.substring(0, lastSectPrIdx);
  let sectPr = bodyContent.substring(lastSectPrIdx, sectPrEndIdx + sectPrEndTag.length);

  // Remove <w:type w:val="continuous"/> para que o corpo seja seção independente
  sectPr = sectPr.replace(/<w:type\s+w:val="continuous"\s*\/>/g, "");
  // Remove pgNumType existente e adiciona reinício na página 1
  sectPr = sectPr.replace(/<w:pgNumType\b[^/]*\/>/g, "");
  sectPr = sectPr.replace("</w:sectPr>", '<w:pgNumType w:start="1"/></w:sectPr>');

  // Resultado: [quadro] + [corpo2] + [sectPr modificado] + </w:body> + sufixo
  return beforeSectPr + corpo2 + sectPr + BODY_CLOSE + suffix;
}

// ─── SIGLAS PERMITIDAS ───────────────────────────────────────────────────────
const SIGLAS_VALIDAS = SIGLAS_ATIVAS;

// ─── VALIDAÇÃO DE ENTRADA ────────────────────────────────────────────────────
function validarEntrada(dados: ContratoRequest): string | null {
  if (!dados || typeof dados !== "object") return "Payload inválido";

  // sigla
  if (!dados.sigla || typeof dados.sigla !== "string")
    return "Campo obrigatório: sigla";
  if (!SIGLAS_VALIDAS.has(dados.sigla))
    return `Sigla inválida: ${dados.sigla}. Permitidas: ${[...SIGLAS_VALIDAS].join(", ")}`;

  // unidade
  if (!dados.unidade || typeof dados.unidade !== "string")
    return "Campo obrigatório: unidade";
  if (dados.unidade.length > 20)
    return "unidade: máximo 20 caracteres";

  // compradores
  if (!Array.isArray(dados.compradores) || dados.compradores.length === 0)
    return "Campo obrigatório: compradores (array com ao menos 1 item)";
  if (dados.compradores.length > 2)
    return "compradores: máximo 2 compradores";
  for (const c of dados.compradores) {
    if (!c.nome || typeof c.nome !== "string") return "Comprador: nome obrigatório";
    if (!c.cpf  || typeof c.cpf  !== "string") return "Comprador: cpf obrigatório";
    if (c.nome.length > 200) return "Comprador: nome muito longo";
  }

  // preço
  const preco = dados.preco_direto ?? dados.valor_venda_manual;
  if (preco !== undefined) {
    if (typeof preco !== "number" || preco <= 0 || preco > 1e9)
      return "Preço inválido: deve ser número positivo até 1 bilhão";
  }

  // parcelas diretas
  if (dados.parcelas_diretas) {
    if (!Array.isArray(dados.parcelas_diretas))
      return "parcelas_diretas deve ser um array";
    for (const p of dados.parcelas_diretas) {
      if (typeof p.valor !== "number" || p.valor < 0)
        return "Parcela: valor deve ser número não-negativo";
    }
  }

  // corretores
  if (dados.corretores) {
    if (!Array.isArray(dados.corretores)) return "corretores deve ser um array";
    if (dados.corretores.length > 20) return "corretores: máximo 20";
    for (const c of dados.corretores) {
      if (!c.nome || typeof c.nome !== "string") return "Corretor: nome obrigatório";
      if (c.valor !== undefined && (typeof c.valor !== "number" || c.valor < 0))
        return "Corretor: valor deve ser número não-negativo";
    }
  }

  return null; // tudo ok
}

// ─── HANDLER PRINCIPAL ───────────────────────────────────────────────────────

// Origens permitidas (adicionar domínio Lovable quando definido)
const ORIGENS_PERMITIDAS = new Set([
  "https://adngbijkqkuaqwggjllo.supabase.co",
  // "https://seu-projeto.lovable.app",  ← adicionar quando disponível
]);

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ORIGENS_PERMITIDAS.has(origin) ? origin : "*"; // fallback * para testes via PowerShell

  const corsHeaders = {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // Limite de tamanho do payload: 100 KB
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > 100_000) {
    return new Response(
      JSON.stringify({ error: "Payload muito grande (máx 100 KB)" }),
      { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }

  try {
    let dados: ContratoRequest;
    try {
      dados = await req.json();
    } catch {
      return new Response(
        JSON.stringify({ error: "JSON inválido" }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Validação de entrada
    const erroValidacao = validarEntrada(dados);
    if (erroValidacao) {
      return new Response(
        JSON.stringify({ error: erroValidacao }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ─── Parcelas e preço
    let parcelas: Parcela[];
    let preco: number;

    if (dados.parcelas_diretas?.length) {
      parcelas = dados.parcelas_diretas;
      preco    = dados.preco_direto || 0;
    } else {
      const r  = interpretarFluxo(dados.fluxo || "");
      parcelas = r.parcelas;
      preco    = dados.valor_venda_manual || r.valor_venda;
    }

    const sinal = parcelas.find(p => p.tipo === "ato")?.valor || 0;
    const comps = parcelas.filter(p => p.tipo === "complemento");
    const p30        = comps[0]?.valor || 0;
    const p60        = comps[1]?.valor || 0;

    const comissao = definirTipoComissao(preco, sinal, p30, p60);
    if (dados.parcela_desconto_manual) {
      comissao.tipo = "destacada";
      comissao.parcela_desconto = dados.parcela_desconto_manual;
    }

    // ─── Templates
    const tpls = getTemplates(dados.sigla || "", comissao.tipo);

    // ─── Fração ideal e vagas (busca no banco se não vier no payload)
    let fracaoIdeal = dados.fracao_ideal || "";
    let vagas       = dados.vagas || "";

    if (dados.sigla && dados.unidade && (!fracaoIdeal || !vagas)) {
      const { data: u } = await supabase
        .from("unidades")
        .select("fracao_ideal, vagas")
        .eq("sigla", dados.sigla)
        .eq("unidade", dados.unidade)
        .single();
      if (u) {
        fracaoIdeal = u.fracao_ideal || fracaoIdeal;
        vagas       = String(u.vagas ?? vagas);
      }
    }

    // ─── Download dos templates do Storage
    const [dl1, dl2] = await Promise.all([
      supabase.storage.from("templates").download(tpls.contrato),
      supabase.storage.from("templates").download(tpls.corpo),
    ]);

    if (dl1.error || dl2.error || !dl1.data || !dl2.data) {
      return new Response(
        JSON.stringify({ error: "Template não encontrado", tpls }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ─── Descomprimir
    const zip1 = unzipSync(new Uint8Array(await dl1.data.arrayBuffer()));
    const zip2 = unzipSync(new Uint8Array(await dl2.data.arrayBuffer()));

    let xml1 = strFromU8(zip1["word/document.xml"]);
    let xml2 = strFromU8(zip2["word/document.xml"]);

    // ─── Imobiliária (só faturado)
    let imobStr = "";
    if (comissao.tipo === "faturada" && dados.imobiliarias?.length) {
      const im = dados.imobiliarias[0];
      imobStr  = im.empresa || im.nome || "";
    }

    // ─── Comunicação — tratada por substituirComunicacao() após substituir()

    // ─── Assinatura
    const tipoAssStr = dados.tipo_ass === "digital" ? "Eletrônica" : "Presencial";
    const ass1       = dados.compradores[0]?.nome || "";
    const ass2       = dados.compradores[1]?.nome || "";

    // ─── Valores líquidos (destacada = preço e sinal já descontados da comissão)
    const totalComissao = dados.corretores?.length
      ? dados.corretores.reduce((s, c) => s + (c.valor || 0), 0)
      : comissao.total_comissao;
    const sinalExibido = (comissao.tipo === "destacada" && comissao.parcela_desconto === "ato")
      ? Math.max(0, sinal - totalComissao)
      : sinal;
    const precoExibido = comissao.tipo === "destacada"
      ? Math.max(0, preco - totalComissao)
      : preco;
    const percentual = preco > 0 ? (sinalExibido / preco * 100) : 0;

    // ─── Substituições
    xml1 = substituir(xml1, {
      "«COMPRADORA»":       montarCompradora(dados),
      "«FRACAO_IDEAL»":     fracaoIdeal,
      "«IMOBILIARIA»":      imobStr,
      "«PORCENTAGEMSINAL»": formatarPercentual(percentual),
      "«PRECO»":            `${formatar(precoExibido)} (${extenso(precoExibido)})`,
      "«SINAL»":            formatar(sinalExibido),
      "«UNIDADE»":          dados.unidade || "",
      "«VAGAS»":            vagas,
      "«VLR_COMISSAO»":     formatar(totalComissao),
    });
    xml1 = substituirPagamento(xml1, parcelas);
    xml1 = substituirComunicacao(xml1, dados);

    xml2 = substituir(xml2, {
      "«ASS_1»":           ass1,
      "«ASS_2»":           ass2,
      "«Data_Assinatura»": dados.data_assinatura || "",
      "«TIPO_ASS»":        tipoAssStr,
      "«UNIDADE»":         dados.unidade || "",
    });

    // ─── Corretores
    if (dados.corretores?.length) {
      xml1 = substituirCorretores(xml1, dados.corretores);
    }

    // ─── Mesclar e recomprimir
    const xmlFinal = mesclarDocs(xml1, xml2);

    // ─── Corrige rodapés para paginação por seção
    const zipBase = { ...zip1, "word/document.xml": strToU8(xmlFinal) };

    if (zipBase["word/footer1.xml"]) {
      // Quadro (footer1): NUMPAGES → SECTIONPAGES para contar só páginas do quadro
      let footer1 = strFromU8(zipBase["word/footer1.xml"]);
      footer1 = footer1.replace(/\bNUMPAGES\b/g, "SECTIONPAGES");
      zipBase["word/footer1.xml"] = strToU8(footer1);

      // Corpo (footer2): tem texto estático "18 de 18" sem campos vivos.
      // Geramos um footer2 baseado no footer1, com SECTIONPAGES e sem "do Quadro-Resumo"
      let footer2 = footer1
        .replace(/<w:r[^>]*><w:t[^>]*> do Quadro-Resumo<\/w:t><\/w:r>/g, "")
        .replace(/ do Quadro-Resumo/g, "");
      zipBase["word/footer2.xml"] = strToU8(footer2);
    }

    const newZip    = zipBase;
    const docxBytes = zipSync(newZip);

    // ─── Salvar histórico
    try {
      await supabase.from("historico_contratos").insert({
        sigla:         dados.sigla || "",
        unidade:       dados.unidade || "",
        comprador:     ass1,
        tipo_comissao: comissao.tipo,
        valor_total:   preco,
        nome_arquivo:  `${dados.sigla || ""} ${dados.unidade || ""} - Contrato.docx`.trim(),
      });
    } catch (_) { /* histórico não bloqueia geração */ }

    // ─── Retornar arquivo
    const filename = `${dados.sigla || ""} ${dados.unidade || ""} - Contrato Promessa de Compra e Venda.docx`.trim();

    return new Response(docxBytes, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename}"`,
        ...corsHeaders,
      },
    });

  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
