// Soter — Edge Function: gerar-contrato
// Motor de geração de contratos em TypeScript (migrado de Python)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { unzipSync, zipSync, strToU8, strFromU8 } from "npm:fflate";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TAXA_COMISSAO = 0.043;

const CALIBRI_12 = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="24"/><w:szCs w:val="24"/>';

// Placeholders that should be replaced without bold formatting
const NO_BOLD_PLACEHOLDERS = new Set([
  "«COMPRADORA»", "«IMOBILIARIA»", "«ASS_1»", "«ASS_2»", "«TIPO_ASS»",
]);

// ─── TIPOS ───────────────────────────────────────────────────────────────────

interface Conjuge {
  nome: string;
  cpf: string;
  sexo?: string;
  nacionalidade?: string;
  profissao?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
  regime_bens?: string;
}

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
  conjuge?: Conjuge;
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
  cnpj?: string;
  percentual?: number;
  valor?: number;
}

// ─── SLOTS (novo modelo multi-comprador) ─────────────────────────────────────

interface ParceiroSlot {
  nome: string;
  cpf: string;
  sexo?: string;
  nacionalidade?: string;
  profissao?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
  relacao: "casado" | "união estável";
  regime?: string;
  data_escritura?: string;
}

interface PFSlot {
  tipo: "PF";
  nome: string;
  cpf: string;
  sexo?: string;
  nacionalidade?: string;
  profissao?: string;
  estado_civil?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
  parceiro?: ParceiroSlot;
}

interface RepresentanteSlot {
  nome: string;
  cpf?: string;
  sexo?: string;
  profissao?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
}

interface PJSlot {
  tipo: "PJ";
  razao_social: string;
  cnpj?: string;
  endereco_pj?: string;
  representante?: RepresentanteSlot;
}

type Slot = PFSlot | PJSlot;

interface ContratoRequest {
  slots?: Slot[];
  compradores: Comprador[];
  relacao?: string;
  regime_bens?: string;
  data_escritura?: string;
  endereco?: string;
  telefone?: string;
  email?: string;
  sigla?: string;
  unidade?: string;
  bloco?: string;
  fracao_ideal?: string;
  vagas?: string;
  parcelas_diretas: Parcela[];
  preco_direto: number;
  data_assinatura?: string;
  tipo_ass?: string;
  corretores?: Corretor[];
  imobiliarias?: Imobiliaria[];
  parcela_desconto_manual?: string;
}

// ─── EMPREENDIMENTOS ─────────────────────────────────────────────────────────
// Templates são resolvidos pelas colunas da tabela `empreendimentos`.
// Fallback para convenção de nome caso as colunas estejam vazias:
// "[SIGLA] contrato_cabeca.docx", "[SIGLA] corpo_cabeca.docx", etc.

interface EmpTemplates {
  template_contrato_destacada?: string | null;
  template_corpo_destacada?: string | null;
  template_contrato_faturada?: string | null;
  template_corpo_faturada?: string | null;
}

function getTemplates(sigla: string, tipo: string, emp?: EmpTemplates) {
  const s = sigla?.toUpperCase();
  if (tipo === "destacada") {
    return {
      contrato: emp?.template_contrato_destacada || `${s} contrato_cabeca.docx`,
      corpo:    emp?.template_corpo_destacada    || `${s} corpo_cabeca.docx`,
    };
  }
  return {
    contrato: emp?.template_contrato_faturada || `${s} contrato_faturado.docx`,
    corpo:    emp?.template_corpo_faturada    || `${s} corpo_faturado.docx`,
  };
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

  const cents   = Math.round(valor * 100);
  const inteiro = Math.floor(cents / 100);
  const ctvs    = cents % 100;

  let r = "";
  if (inteiro === 0) {
    r = "zero";
  } else {
    const milh = Math.floor(inteiro / 1_000_000);
    const mil  = Math.floor((inteiro % 1_000_000) / 1_000);
    const res  = inteiro % 1_000;
    const partes: string[] = [];
    if (milh) partes.push(grupo(milh) + (milh === 1 ? " milhão" : " milhões"));
    if (mil)  partes.push(mil === 1 ? "um mil" : grupo(mil) + " mil");
    if (res)  partes.push(grupo(res));
    r = partes.join(" e ") + (inteiro === 1 ? " real" : " reais");
  }
  if (ctvs > 0) r += " e " + grupo(ctvs) + (ctvs === 1 ? " centavo" : " centavos");
  return r;
}

// ─── COMISSÃO ────────────────────────────────────────────────────────────────

function definirTipoComissao(preco: number, sinal: number, p30 = 0, p60 = 0, taxa = TAXA_COMISSAO) {
  if (!preco || preco <= 0) {
    return { tipo: "faturada", total_comissao: 0, parcela_desconto: null };
  }
  const comissao = Math.round(preco * taxa * 100) / 100;
  const limiar   = preco * 0.10;

  let tipo: string;
  let parcela_desconto: string | null;

  if (sinal >= limiar)               { tipo = "destacada"; parcela_desconto = "ato"; }
  else if (sinal + p30 >= limiar)    { tipo = "destacada"; parcela_desconto = "complemento_30"; }
  else if (sinal + p30 + p60 >= limiar) { tipo = "destacada"; parcela_desconto = "complemento_60"; }
  else                               { tipo = "faturada";  parcela_desconto = null; }

  return { tipo, total_comissao: comissao, parcela_desconto };
}

// ─── PAGAMENTO ───────────────────────────────────────────────────────────────

function romano(n: number): string {
  const r = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x"];
  return n < r.length ? r[n] : String(n);
}

const ROMANOS = ["i","ii","iii","iv","v","vi","vii","viii","ix","x"];

function linhasPagamento(parcelas: Parcela[], descontoComp?: { parcela: string; valor: number }): string[] {
  const textos: string[] = [];
  const temDescontoComp = descontoComp?.parcela === "complemento_30" || descontoComp?.parcela === "complemento_60";
  const comps = parcelas.filter(p => p.tipo === "complemento");
  let compEmitido = false;

  // Contar quantas ocorrências de cada tipo haverá no texto (para sufixos romanos no label)
  const contagem: Record<string, number> = {};
  for (const p of parcelas) {
    if (p.tipo === "ato") continue;
    if (p.tipo === "complemento" && temDescontoComp && comps.length >= 2) continue;
    contagem[p.tipo] = (contagem[p.tipo] || 0) + 1;
  }
  const indice: Record<string, number> = {};
  const sufixo = (tipo: string): string => {
    if ((contagem[tipo] || 0) <= 1) return "";
    indice[tipo] = (indice[tipo] || 0) + 1;
    return ` (${ROMANOS[indice[tipo] - 1] ?? indice[tipo]})`;
  };

  let lineNum = 0; // global sequential counter for (i), (ii), (iii)...

  for (const p of parcelas) {
    if (p.tipo === "ato") continue;

    // Complemento com comissão destacada: agrupa os dois em um único item com valores diferentes
    if (p.tipo === "complemento" && temDescontoComp && comps.length >= 2) {
      if (!compEmitido) {
        compEmitido = true;
        lineNum++;
        const prefix = `(${romano(lineNum)}) `;
        const comissao = descontoComp!.valor;
        const [val1, val2] = descontoComp!.parcela === "complemento_30"
          ? [Math.max(0, comps[0].valor - comissao), comps[1].valor]
          : [comps[0].valor, Math.max(0, comps[1].valor - comissao)];
        const total = val1 + val2;
        const data1 = comps[0].data || "";
        const reaj  = comps[0].reajustavel !== false ? "reajustáveis" : "fixas";
        textos.push(
          `${prefix}R$${formatar(total)} (${extenso(total)}) serão pagos em 2 (duas) parcelas ${reaj}, ` +
          `mensais, sucessivas, a primeira no valor de R$${formatar(val1)} (${extenso(val1)}) ` +
          `vencendo-se a primeira no dia ${data1} e a outra no valor de R$${formatar(val2)} ` +
          `(${extenso(val2)}) no mesmo dia do mês subsequente ("Parcelas de Complemento de Sinal");`
        );
      }
      continue;
    }

    lineNum++;
    const prefix = `(${romano(lineNum)}) `;
    const qtd       = p.qtd || 1;
    const total     = p.valor * qtd;
    const valorUnit = formatar(p.valor);
    const valorTot  = formatar(total);
    const data      = p.data || "";
    const reaj      = p.reajustavel !== false ? "reajustáveis" : "fixas";

    if (p.tipo === "financiamento" || p.tipo === "unica") {
      const baseLabel = p.tipo === "financiamento" ? "Parcela de Financiamento" : "Parcela Única";
      const label = baseLabel + sufixo(p.tipo);
      const reajUnit = p.reajustavel !== false ? "reajustável" : "fixa";
      textos.push(
        `${prefix}R$${valorUnit} (${extenso(p.valor)}) serão pagos em uma única ` +
        `parcela ${reajUnit} com vencimento em ${data} ("${label}");`
      );
      continue;
    }

    let baseDescricao: string, period: string, subsequente: string;
    const demais = qtd === 2 ? "a outra" : "as demais";
    if      (p.tipo === "mensal")      { baseDescricao = "Parcelas Mensais";                 period = "mensais";    subsequente = qtd === 2 ? "no mesmo dia do mês subsequente"          : "no mesmo dia dos meses subsequentes"; }
    else if (p.tipo === "anual")       { baseDescricao = "Parcelas Anuais";                  period = "anuais";     subsequente = "no mesmo dia dos anos subsequentes"; }
    else if (p.tipo === "semestral")   { baseDescricao = "Parcelas Semestrais";              period = "semestrais"; subsequente = "no mesmo dia de seis em seis meses"; }
    else if (p.tipo === "complemento") { baseDescricao = "Parcelas de Complemento de Sinal"; period = "mensais";    subsequente = qtd === 2 ? "no mesmo dia do mês subsequente"          : "no mesmo dia dos meses subsequentes"; }
    else                               { baseDescricao = "Parcelas";                          period = "mensais";    subsequente = qtd === 2 ? "no mesmo dia do mês subsequente"          : "no mesmo dia dos meses subsequentes"; }

    const descricao = baseDescricao + sufixo(p.tipo);

    textos.push(
      `${prefix}R$${valorTot} (${extenso(total)}) serão pagos em ${qtd} parcelas ` +
      `${reaj}, ${period}, sucessivas, no valor de R$${valorUnit} (${extenso(p.valor)}) ` +
      `cada uma delas, vencendo-se a primeira no dia ${data} e ${demais} ${subsequente} ("${descricao}");`
    );
  }
  return textos;
}

// substituirPagamento: substitui o parágrafo «PAGAMENTO» por N parágrafos (um por parcela)
function substituirPagamento(xml: string, parcelas: Parcela[], descontoComp?: { parcela: string; valor: number }): string {
  const linhas = linhasPagamento(parcelas, descontoComp);
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
  let pEnd = xml.indexOf("</w:p>", idx) + "</w:p>".length;
  if (pStart === -1 || pEnd < idx) return xml;

  const paraOrig = xml.substring(pStart, pEnd);

  // Extrai <w:pPr> para reutilizar em cada novo parágrafo
  const pPrMatch = paraOrig.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/);
  const pPr      = pPrMatch ? pPrMatch[0] : "";

  // Extrai o numId do parágrafo original (se houver)
  const numIdMatch = pPr.match(/<w:numId\s+w:val="(\d+)"/);
  const origNumId  = numIdMatch ? numIdMatch[1] : null;

  // Extrai <w:rPr> do run original e força Calibri 12pt sem negrito
  const rPrMatch = paraOrig.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/);
  const rPrRaw   = rPrMatch ? rPrMatch[0] : "<w:rPr></w:rPr>";
  const rPr = rPrRaw
    .replace(/<w:rFonts\b[^/]*\/>/g, "")
    .replace(/<w:sz\b[^>]*\/>/g, "")
    .replace(/<w:szCs\b[^>]*\/>/g, "")
    .replace(/<w:b\/>/g, "")
    .replace(/<w:bCs\/>/g, "")
    .replace("</w:rPr>", `${CALIBRI_12}</w:rPr>`);

  // Remove parágrafos "fantasma" logo após o placeholder: parágrafos que têm o
  // mesmo numId e contêm apenas "." (resíduo de template com lista numerada).
  // Parágrafos vazios entre o placeholder e o fantasma são pulados durante a
  // busca — e também removidos quando o fantasma é encontrado, pois pEnd salta
  // para além do fantasma, englobando os vazios intermediários.
  if (origNumId) {
    let pos2 = pEnd;
    while (true) {
      const nextP = xml.indexOf("<w:p", pos2);
      if (nextP === -1) break;
      const charAfter = xml[nextP + 4];
      if (charAfter !== ">" && charAfter !== " ") { pos2 = nextP + 1; continue; }
      const nextPEnd = xml.indexOf("</w:p>", nextP) + "</w:p>".length;
      const nextPara = xml.substring(nextP, nextPEnd);
      const hasNumId = nextPara.includes(`<w:numId w:val="${origNumId}"`);
      const textOnly = [...nextPara.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)]
        .map(m => m[1]).join("").trim();
      if (hasNumId && textOnly === ".") {
        pEnd = nextPEnd; // inclui vazios anteriores e o próprio fantasma
        pos2 = pEnd;
        continue;
      }
      if (textOnly === "") {
        pos2 = nextPEnd; // pula vazio sem confirmar remoção ainda
        continue;
      }
      break;
    }
  }

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
  // Remove bold and force Calibri 12pt for communication text
  const rPr = rPrMatch
    ? rPrMatch[0]
        .replace(/<w:rFonts\b[^/]*\/>/g, "")
        .replace(/<w:sz\b[^>]*\/>/g, "")
        .replace(/<w:szCs\b[^>]*\/>/g, "")
        .replace(/<w:b\/>/g, "")
        .replace(/<w:bCs\/>/g, "")
        .replace("</w:rPr>", `${CALIBRI_12}</w:rPr>`)
    : `<w:rPr>${CALIBRI_12}</w:rPr>`;

  const linhas: string[] = [];
  if (dados.compradores[0]?.nome) linhas.push(`At.: ${escapeXml(dados.compradores[0].nome)}`);
  if (dados.endereco)              linhas.push(`End.: ${escapeXml(dados.endereco)}`);
  if (dados.telefone)              linhas.push(`Tel.: ${escapeXml(formatarTelefone(dados.telefone))}`);
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

function formatarTelefone(tel: string): string {
  if (!tel) return tel;
  const digits = tel.replace(/\D/g, "");
  const d = digits.startsWith("55") && digits.length > 11 ? digits.slice(2) : digits;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel;
}

function isoBR(dateStr: string): string {
  if (!dateStr || dateStr.length !== 10) return dateStr;
  try {
    const [y, m, d] = dateStr.split("-");
    return `${d}/${m}/${y}`;
  } catch { return dateStr; }
}

const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

function dataExtenso(dateStr: string): string {
  if (!dateStr) return "";
  // Accepts "DD/MM/YYYY" or "YYYY-MM-DD"
  let d: string, m: string, y: string;
  if (dateStr.includes("-")) {
    [y, m, d] = dateStr.split("-");
  } else {
    [d, m, y] = dateStr.split("/");
  }
  const mes = MESES[parseInt(m, 10) - 1] || m;
  return `${parseInt(d, 10)} de ${mes} de ${y}`;
}

// ─── COMPRADORA ──────────────────────────────────────────────────────────────

// estadoCivilAntes=true para união estável (ordem: nac, estado, prof)
// estadoCivilAntes=false (padrão) para demais casos (ordem: nac, prof, estado)
function qualificar(c: Comprador, estadoCivilAntes = false): string {
  const inscrito = (c.sexo || "M") === "M" ? "inscrito"  : "inscrita";
  const portador = (c.sexo || "M") === "M" ? "portador"  : "portadora";
  const nac      = (c.nacionalidade || "brasileiro(a)").toLowerCase();
  const prof     = (c.profissao || "").trim();
  const estado   = c.estado_civil ? c.estado_civil.replace("(a)", "").trim() : "";
  const midParts = estadoCivilAntes
    ? [estado, prof].filter(Boolean)
    : [prof, estado].filter(Boolean);
  const rgPart = c.rg
    ? `, ${portador} da identidade nº ${c.rg}${c.orgao_emissor ? ` do ${c.orgao_emissor}` : ""}${c.data_emissao ? ` em ${isoBR(c.data_emissao)}` : ""}`
    : "";
  return (
    `${c.nome}, ${nac}, ${midParts.join(", ")}, ` +
    `${inscrito} no CPF/ME sob o nº ${c.cpf}${rgPart}`
  );
}

function qualificarSimples(c: { nome: string; nacionalidade?: string; profissao?: string }): string {
  const nac   = (c.nacionalidade || "brasileiro(a)").toLowerCase();
  const prof  = (c.profissao || "").trim();
  const parts = [nac, prof].filter(Boolean);
  return `${c.nome}, ${parts.join(", ")}`;
}

function rgStr(c: { rg?: string; orgao_emissor?: string; data_emissao?: string }): string | null {
  if (!c.rg) return null;
  let s = c.rg;
  if (c.orgao_emissor) s += ` do ${c.orgao_emissor}`;
  if (c.data_emissao)  s += ` em ${isoBR(c.data_emissao)}`;
  return s;
}

function qualificarComConjuge(c: Comprador): string {
  const conj = c.conjuge!;
  const conjLabel = (conj.sexo || "F") === "F" ? "sua mulher" : "seu marido";
  const regime = conj.regime_bens || "";
  const cpfPart = `inscritos no CPF/ME sob os nºs ${c.cpf} e ${conj.cpf}`;
  const rg1 = rgStr(c), rg2 = rgStr(conj);
  let rgPart = "";
  if (rg1 && rg2) rgPart = `, portadores das identidades nºs ${rg1} e ${rg2}`;
  else if (rg1)   rgPart = `, portador(a) da identidade nº ${rg1}`;
  else if (rg2)   rgPart = `, portador(a) da identidade nº ${rg2}`;
  return (
    `${qualificarSimples(c)}, e ${conjLabel} ${qualificarSimples(conj)}, ` +
    `casados pelo regime da ${regime.toLowerCase()}, ` +
    `${cpfPart}${rgPart}`
  );
}

// ─── QUALIFICAÇÃO PJ ─────────────────────────────────────────────────────────

function qualificarPJ(slot: PJSlot): string {
  const cnpj = slot.cnpj ? `, inscrita no CNPJ/ME sob o nº ${slot.cnpj}` : "";
  const sede  = slot.endereco_pj ? `, com sede na ${slot.endereco_pj}` : "";
  const rep   = slot.representante;
  let repPart = "";
  if (rep?.nome) {
    const s   = (rep.sexo || "M") === "M" ? "M" : "F";
    const ins  = s === "M" ? "inscrito" : "inscrita";
    const por  = s === "M" ? "portador" : "portadora";
    const nac  = ((rep as any).nacionalidade || (s === "M" ? "brasileiro" : "brasileira")).toLowerCase();
    const prof = rep.profissao ? `, ${rep.profissao}` : "";
    const rg   = rep.rg ? `, ${por} da identidade nº ${rep.rg}${rep.orgao_emissor ? ` do ${rep.orgao_emissor}` : ""}` : "";
    const cpfR = rep.cpf ? `, ${ins} no CPF/ME sob o nº ${rep.cpf}` : "";
    repPart = `, neste ato representada por ${rep.nome}, ${nac}${prof}${cpfR}${rg}`;
  }
  return `${slot.razao_social}${cnpj}${sede}${repPart}`;
}

// ─── QUALIFICAÇÃO PF COM PARCEIRO ─────────────────────────────────────────────

function qualificarPFComParceiro(slot: PFSlot): string {
  const parc = slot.parceiro!;
  const c: Comprador = {
    nome: slot.nome, cpf: slot.cpf, sexo: slot.sexo,
    nacionalidade: slot.nacionalidade, profissao: slot.profissao,
    rg: slot.rg, orgao_emissor: slot.orgao_emissor, data_emissao: slot.data_emissao,
  };

  if (parc.relacao === "casado") {
    const conjuge: Conjuge = {
      nome: parc.nome, cpf: parc.cpf, sexo: parc.sexo,
      nacionalidade: parc.nacionalidade, profissao: parc.profissao,
      rg: parc.rg, orgao_emissor: parc.orgao_emissor, data_emissao: parc.data_emissao,
      regime_bens: parc.regime,
    };
    return qualificarComConjuge({ ...c, conjuge });
  }

  // União estável
  const pSexo = (parc.sexo || "F") === "F" ? "F" : "M";
  const conjLabel   = pSexo === "F" ? "sua companheira" : "seu companheiro";
  const regime      = parc.regime || "";
  const regimePart  = regime ? ` com ${regime.toLowerCase()}` : "";
  const dataEsc     = parc.data_escritura ? ` assinada em ${isoBR(parc.data_escritura)}` : "";
  const cpfPart     = `inscritos no CPF/ME sob os nºs ${slot.cpf} e ${parc.cpf}`;
  const rg1 = rgStr(c), rg2 = rgStr(parc as any);
  let rgPart = "";
  if (rg1 && rg2) rgPart = `, portadores das identidades nºs ${rg1} e ${rg2}`;
  else if (rg1)   rgPart = `, portador(a) da identidade nº ${rg1}`;
  else if (rg2)   rgPart = `, portador(a) da identidade nº ${rg2}`;

  return (
    `${qualificarSimples(c)}, e ${conjLabel} ${qualificarSimples(parc as any)}, ` +
    `${cpfPart}${rgPart}, ` +
    `que declaram viver em união estável${regimePart} através de escritura pública declaratória${dataEsc}`
  );
}

// ─── MONTAR COMPRADORA A PARTIR DE SLOTS ──────────────────────────────────────

function montarCompradoraFromSlots(dados: ContratoRequest): string {
  const slots   = dados.slots!;
  const endereco = dados.endereco || "";

  const parts = slots.map((slot) => {
    if (slot.tipo === "PJ") return qualificarPJ(slot as PJSlot);
    const pf = slot as PFSlot;
    if (pf.parceiro) return qualificarPFComParceiro(pf);
    return qualificar(pf as unknown as Comprador);
  });

  if (parts.length === 1) {
    return `${parts[0]}, residente(s) na ${endereco}`;
  }

  const numbered = parts.map((p, i) => `(${i + 1}) ${p}`);
  const last = numbered.pop()!;
  return `${numbered.join("; ")}; e ${last}, residentes na ${endereco}`;
}

function montarImobiliaria(imobiliarias: Imobiliaria[], preco: number): string {
  if (!imobiliarias?.length) return "";
  const partes = imobiliarias.map(im => {
    const nome = im.empresa || im.nome || "";
    const val  = im.valor ?? (preco * (im.percentual ?? 0) / 100);
    const cnpj = im.cnpj ? `, inscrita no CNPJ/ME sob o nº ${im.cnpj}` : "";
    return `R$${formatar(val)} (${extenso(val)}) para ${nome}${cnpj}`;
  });
  const ultimo = partes.pop()!;
  return "sendo " + (partes.length ? partes.join(", ") + " e " : "") + ultimo;
}

function montarCompradora(dados: ContratoRequest): string {
  if (dados.slots && dados.slots.length > 0) {
    return montarCompradoraFromSlots(dados);
  }

  const compradores = dados.compradores;
  const relacao     = dados.relacao || "solteiro / independentes";
  const regime      = dados.regime_bens || "";
  const endereco    = dados.endereco || "";

  // Formata um comprador, usando o bloco de cônjuge se tiver
  const fmt = (c: Comprador) => c.conjuge?.nome ? qualificarComConjuge(c) : qualificar(c);

  if (compradores.length === 1) {
    return `${fmt(compradores[0])}, residente(s) na ${endereco}`;
  }

  const [c1, c2] = compradores;

  // Fluxo legado: dois compradores são o casal (sem conjuge sub-objeto)
  if (relacao === "casado" && !c1.conjuge) {
    const conj = (c2.sexo || "F") === "F" ? "sua mulher" : "seu marido";
    const cpfPart = `inscritos no CPF/ME sob os nºs ${c1.cpf} e ${c2.cpf}`;
    const rg1 = rgStr(c1), rg2 = rgStr(c2);
    let rgPart = "";
    if (rg1 && rg2) rgPart = `, portadores das identidades nºs ${rg1} e ${rg2}`;
    else if (rg1)   rgPart = `, portador(a) da identidade nº ${rg1}`;
    else if (rg2)   rgPart = `, portador(a) da identidade nº ${rg2}`;
    return (
      `${qualificarSimples(c1)}, e ${conj} ${qualificarSimples(c2)}, ` +
      `casados pelo regime da ${regime.toLowerCase()}, ` +
      `${cpfPart}${rgPart}, ` +
      `residente(s) na ${endereco}`
    );
  }

  if (relacao === "união estável") {
    const regimePart    = regime ? ` com ${regime.toLowerCase()}` : "";
    const dataEscritura = dados.data_escritura ? ` assinada em ${isoBR(dados.data_escritura)}` : "";
    return (
      `(1) ${qualificar(c1, true)}; e (2) ${qualificar(c2, true)}, residentes na ${endereco}, ` +
      `ambos declaram viver em união estável${regimePart} através de escritura pública declaratória${dataEscritura}, ` +
      `independentemente de gênero e número, sendo ambos solidariamente responsáveis e representantes entre si`
    );
  }

  // Dois compradores independentes, cada um possivelmente com cônjuge
  return `(1) ${fmt(c1)}; e (2) ${fmt(c2)}, residentes na ${endereco}`;
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
  // Remove também w14:paraId e w14:textId para evitar IDs duplicados ao copiar a linha
  let rowNorm = rowModelo
    .replace(/<w:sz\b[^>]*\/>/g, "")
    .replace(/<w:szCs\b[^>]*\/>/g, "")
    .replace(/<w:rFonts\b[^>]*\/>/g, "")
    .replace(/\s*w14:paraId="[^"]*"/g, "")
    .replace(/\s*w14:textId="[^"]*"/g, "")
    .replace(/\s*w:rsidR="[^"]*"/g, "")
    .replace(/\s*w:rsidRPr="[^"]*"/g, "")
    .replace(/\s*w:rsidRDefault="[^"]*"/g, "");

  // Substitui qualquer jc existente por center; depois adiciona center em pPr sem jc
  rowNorm = rowNorm.replace(/<w:jc\b[^>]*\/>/g, '<w:jc w:val="center"/>');
  rowNorm = rowNorm.replace(/(<w:pPr>)([\s\S]*?)(<\/w:pPr>)/g, (m, open, content, close) =>
    content.includes("<w:jc ") ? m : open + content + '<w:jc w:val="center"/>' + close
  );
  // Força Calibri 12pt em todos os runs da linha
  rowNorm = rowNorm.replace(/(<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g, (m, open, content, close) =>
    open + content + CALIBRI_12 + close
  );
  // Runs sem rPr: insere rPr com Calibri 12pt antes de <w:t>
  rowNorm = rowNorm.replace(/(<w:r\b[^>]*>)(?![\s\S]{0,50}<w:rPr)(<w:t)/g,
    `$1<w:rPr>${CALIBRI_12}</w:rPr>$2`
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

function addPageBreakBefore(xml: string, textMarker: string): string {
  const idx = xml.indexOf(textMarker);
  if (idx === -1) return xml;

  let pStart = -1;
  let pos = idx;
  while (pos > 0) {
    const candidate = xml.lastIndexOf("<w:p", pos);
    if (candidate === -1) break;
    const charAfter = xml[candidate + 4];
    if (charAfter === ">" || charAfter === " ") { pStart = candidate; break; }
    pos = candidate - 1;
  }
  if (pStart === -1) return xml;

  const pageBreakEl = "<w:pageBreakBefore/>";
  const pPrCloseIdx = xml.indexOf("</w:pPr>", pStart);
  const nextPStart  = xml.indexOf("<w:p", pStart + 4);

  if (pPrCloseIdx !== -1 && (nextPStart === -1 || pPrCloseIdx < nextPStart)) {
    return xml.substring(0, pPrCloseIdx) + pageBreakEl + xml.substring(pPrCloseIdx);
  }
  const pTagEnd = xml.indexOf(">", pStart) + 1;
  return xml.substring(0, pTagEnd) + `<w:pPr>${pageBreakEl}</w:pPr>` + xml.substring(pTagEnd);
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
    let prev = "";
    while (prev !== result) {
      prev = result;
      const idx = result.indexOf(placeholder);
      if (idx === -1) break;

      // Localiza o <w:r> (não <w:rPr>) que contém o placeholder
      let rStart = -1;
      let sp = idx;
      while (sp > 0) {
        const c = result.lastIndexOf("<w:r", sp);
        if (c === -1) break;
        const ch = result[c + 4];
        if (ch === ">" || ch === " ") { rStart = c; break; }
        sp = c - 1;
      }

      if (rStart === -1) { result = result.replace(placeholder, safe); continue; }
      const rEnd = result.indexOf("</w:r>", idx);
      if (rEnd === -1) { result = result.replace(placeholder, safe); continue; }
      const rEndFull = rEnd + "</w:r>".length;

      const runOrig = result.substring(rStart, rEndFull);
      const rPrM = runOrig.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/);
      const isNoBold = NO_BOLD_PLACEHOLDERS.has(placeholder);
      let runNew: string;
      if (rPrM) {
        let rPrFixed = rPrM[0]
          .replace(/<w:rFonts\b[^/]*\/>/g, "")
          .replace(/<w:sz\b[^>]*\/>/g, "")
          .replace(/<w:szCs\b[^>]*\/>/g, "");
        if (isNoBold) {
          rPrFixed = rPrFixed.replace(/<w:b\/>/g, "").replace(/<w:bCs\/>/g, "");
        } else if (!rPrFixed.includes("<w:b/>")) {
          rPrFixed = rPrFixed.replace("</w:rPr>", "<w:b/><w:bCs/></w:rPr>");
        }
        rPrFixed = rPrFixed.replace("</w:rPr>", `${CALIBRI_12}</w:rPr>`);
        runNew = runOrig.replace(rPrM[0], rPrFixed);
      } else {
        const boldPart = isNoBold ? "" : "<w:b/><w:bCs/>";
        runNew = runOrig.replace(/(<w:r(?:\s[^>]*)?>)/, `$1<w:rPr>${boldPart}${CALIBRI_12}</w:rPr>`);
      }
      runNew = runNew.replace(placeholder, safe);
      result = result.substring(0, rStart) + runNew + result.substring(rEndFull);
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
  const sectPr       = bodyContent.substring(lastSectPrIdx, sectPrEndIdx + sectPrEndTag.length);

  // sectPr do corpo: remove qualquer type, reinicia na página 1
  let corpoSectPr = sectPr.replace(/<w:type\b[^/]*\/>/g, "");
  corpoSectPr = corpoSectPr.replace(/<w:pgNumType\b[^/]*\/>/g, "");
  corpoSectPr = corpoSectPr.replace("</w:sectPr>", '<w:pgNumType w:start="1"/></w:sectPr>');

  // Se o quadro não tem sectPr intermediário (ex: BAK), insere um parágrafo de quebra
  // de seção usando o sectPr original do template (mantém refs de footer e tamanho de página).
  // Remove w:type para garantir nextPage (padrão) — continuous impede SECTIONPAGES de funcionar.
  const quadroTemBreak = beforeSectPr.includes("<w:sectPr");
  const quadroBreak = quadroTemBreak ? "" :
    `<w:p><w:pPr>${sectPr
      .replace(/<w:type\b[^/]*\/>/g, "")
      .replace(/<w:pgNumType\b[^/]*\/>/g, "")
    }</w:pPr></w:p>`;

  // Resultado: [quadro] + [break se necessário] + [corpo] + [sectPr corpo] + </w:body>
  return beforeSectPr + quadroBreak + corpo2 + corpoSectPr + BODY_CLOSE + suffix;
}

// ─── VALIDAÇÃO DE ENTRADA ────────────────────────────────────────────────────
function validarEntrada(dados: ContratoRequest): string | null {
  if (!dados || typeof dados !== "object") return "Payload inválido";

  // sigla — presença verificada aqui; existência no banco verificada depois
  if (!dados.sigla || typeof dados.sigla !== "string")
    return "Campo obrigatório: sigla";

  // unidade
  if (!dados.unidade || typeof dados.unidade !== "string")
    return "Campo obrigatório: unidade";
  if (dados.unidade.length > 20)
    return "unidade: máximo 20 caracteres";

  // compradores / slots
  const hasSlots = Array.isArray(dados.slots) && dados.slots.length > 0;
  const hasCompradores = Array.isArray(dados.compradores) && dados.compradores.length > 0;
  if (!hasSlots && !hasCompradores)
    return "Campo obrigatório: slots ou compradores (array com ao menos 1 item)";
  if (hasSlots) {
    for (const s of dados.slots!) {
      if (s.tipo === "PJ") {
        if (!s.razao_social) return "PJ: razao_social obrigatório";
      } else {
        const pf = s as PFSlot;
        if (!pf.nome) return "Comprador PF: nome obrigatório";
        if (!pf.cpf)  return "Comprador PF: cpf obrigatório";
      }
    }
  } else {
    for (const c of dados.compradores) {
      if (!c.nome || typeof c.nome !== "string") return "Comprador: nome obrigatório";
      if (!c.cpf  || typeof c.cpf  !== "string") return "Comprador: cpf obrigatório";
      if (c.nome.length > 200) return "Comprador: nome muito longo";
    }
  }

  // preço
  const preco = dados.preco_direto;
  if (preco !== undefined) {
    if (typeof preco !== "number" || preco <= 0 || preco > 1e9)
      return "Preço inválido: deve ser número positivo até 1 bilhão";
  }

  // parcelas diretas — obrigatório
  if (!Array.isArray(dados.parcelas_diretas) || dados.parcelas_diretas.length === 0)
    return "Campo obrigatório: parcelas_diretas (array com ao menos 1 parcela)";
  for (const p of dados.parcelas_diretas) {
    if (typeof p.valor !== "number" || p.valor < 0)
      return "Parcela: valor deve ser número não-negativo";
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
  "https://soter-contratos-ps58ghmbn-leovillacamellos-projects.vercel.app",
  "https://soter-contratos.vercel.app",
]);

serve(async (req) => {
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ORIGENS_PERMITIDAS.has(origin) ? origin : (origin ? null : "*");

  if (allowedOrigin === null) {
    return new Response("Forbidden", { status: 403 });
  }

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

  // 🔒 SEGURANÇA [VULN-5]: validar JWT antes de processar qualquer dado
  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return new Response(
      JSON.stringify({ error: "Autenticação necessária" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  const supabaseAuth = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!);
  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(jwt);
  if (authError || !user) {
    return new Response(
      JSON.stringify({ error: "Token inválido ou expirado" }),
      { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
  // 🔒 SEGURANÇA [VULN-14]: identidade extraída do token para auditoria
  const userId = user.id;
  const userEmail = user.email ?? "";

  // Limite de tamanho do payload: 100 KB
  try {
    let dados: ContratoRequest;
    try {
      const bodyText = await req.text();
      if (bodyText.length > 100_000) {
        return new Response(
          JSON.stringify({ error: "Payload muito grande (máx 100 KB)" }),
          { status: 413, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }
      dados = JSON.parse(bodyText);
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

    // ─── Validar sigla e buscar configuração de templates
    const { data: empRow, error: empError } = await supabase
      .from("empreendimentos")
      .select("sigla, template_contrato_destacada, template_corpo_destacada, template_contrato_faturada, template_corpo_faturada, taxa_comissao")
      .eq("sigla", dados.sigla)
      .single();
    if (empError) {
      console.error("Erro ao validar empreendimento:", empError.message, "sigla:", dados.sigla);
    } else if (!empRow) {
      return new Response(
        JSON.stringify({ error: `Empreendimento não encontrado: ${dados.sigla}` }),
        { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ─── Parcelas e preço
    const parcelas: Parcela[] = dados.parcelas_diretas;
    const preco: number = dados.preco_direto || 0;

    const sinal = parcelas.find(p => p.tipo === "ato")?.valor || 0;
    const comps = parcelas.filter(p => p.tipo === "complemento");
    const p30        = comps[0]?.valor || 0;
    const p60        = comps[1]?.valor || 0;

    const taxaEmp = ((empRow?.taxa_comissao as number) ?? 4.3) / 100;
    const comissao = definirTipoComissao(preco, sinal, p30, p60, taxaEmp);
    const PARCELAS_VALIDAS = new Set(["ato", "complemento_30", "complemento_60"]);
    if (dados.parcela_desconto_manual) {
      if (!PARCELAS_VALIDAS.has(dados.parcela_desconto_manual))
        return new Response(JSON.stringify({ error: "parcela_desconto_manual inválida" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      comissao.tipo = "destacada";
      comissao.parcela_desconto = dados.parcela_desconto_manual;
    }

    // ─── Templates — usa colunas do banco, fallback para convenção de nome
    const tpls = getTemplates(dados.sigla || "", comissao.tipo, empRow ?? undefined);

    // ─── Fração ideal e vagas — sempre do banco, nunca do payload
    let fracaoIdeal = "";
    let vagas       = "";

    if (dados.sigla && dados.unidade) {
      let query = supabase
        .from("unidades")
        .select("fracao_ideal, vagas")
        .eq("sigla", dados.sigla)
        .eq("unidade", dados.unidade);
      if (dados.bloco) query = query.eq("bloco", dados.bloco);
      const { data: u, error: uErr } = await query.single();
      if (uErr) console.error("unidades lookup error:", JSON.stringify(uErr));
      if (u) {
        fracaoIdeal = u.fracao_ideal || "";
        vagas       = String(u.vagas ?? "");
      }
    }

    // ─── Download dos templates do Storage
    const [dl1, dl2] = await Promise.all([
      supabase.storage.from("templates").download(tpls.contrato),
      supabase.storage.from("templates").download(tpls.corpo),
    ]);

    if (dl1.error || dl2.error || !dl1.data || !dl2.data) {
      console.error("Template não encontrado:", tpls, dl1.error, dl2.error);
      return new Response(
        JSON.stringify({ error: "Erro interno ao carregar template" }),
        { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // ─── Descomprimir
    const zip1 = unzipSync(new Uint8Array(await dl1.data.arrayBuffer()));
    const zip2 = unzipSync(new Uint8Array(await dl2.data.arrayBuffer()));

    let xml1 = strFromU8(zip1["word/document.xml"]);
    let xml2 = strFromU8(zip2["word/document.xml"]);

    // ─── Imobiliária
    // Faturado (BCO/H23/AAZ): formato completo "sendo R$X (extenso) para NOME, CNPJ"
    // Destacada com «IMOBILIARIA» no template (SMK cabeca): só o nome da empresa
    let imobStr = "";
    if (dados.imobiliarias?.length) {
      if (comissao.tipo === "faturada") {
        imobStr = montarImobiliaria(dados.imobiliarias, preco);
      } else {
        // Destacada: preenche só o nome (templates como SMK cabeca têm «IMOBILIARIA»
        // na cláusula "qual seja, a empresa X" — não esperam valor monetário)
        imobStr = dados.imobiliarias
          .map(im => im.empresa || im.nome || "")
          .filter(Boolean).join(" e ");
      }
    }

    // ─── Comunicação — tratada por substituirComunicacao() após substituir()

    // ─── Assinatura
    const tipoAssStr = dados.tipo_ass === "digital"
      ? "meio digital"
      : "2 (duas) vias físicas de igual forma e teor";
    const slotName = (s?: Slot) => !s ? "" : s.tipo === "PJ" ? s.razao_social : (s as PFSlot).nome || "";
    const ass1 = dados.slots?.length ? slotName(dados.slots[0]) : (dados.compradores[0]?.nome || "");
    const ass2 = dados.slots?.length ? slotName(dados.slots[1]) : (dados.compradores[1]?.nome || "");

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
    const percentual = precoExibido > 0 ? (sinalExibido / precoExibido * 100) : 0;

    // ─── Substituições
    xml1 = substituir(xml1, {
      "«COMPRADORA»":        montarCompradora(dados),
      "«FRACAO_IDEAL»":      fracaoIdeal,
      "«IMOBILIARIA»":       imobStr,
      "«PORCENTAGEMSINAL»":  formatarPercentual(percentual),
      "«PRECO»":             `R$${formatar(precoExibido)} (${extenso(precoExibido)})`,
      "«SINAL»":             `R$${formatar(sinalExibido)} (${extenso(sinalExibido)})`,
      "«UNIDADE»":           dados.unidade || "",
      "«VAGAS»":             vagas,
      "«VLR_COMISSAO»":      `R$${formatar(totalComissao)} (${extenso(totalComissao)})`,
      // AAZ/SMK/DMS: total sem centavos (template já tem R$ e ,00 hardcoded)
      "«TOTAL_COMISSAO»":    formatar(totalComissao).replace(/,\d{2}$/, ""),
    });
    // Template faturado tem "qual seja, " hardcoded antes de «IMOBILIARIA» (runs separados).
    // Remove "qual seja, " que sobrou no nó de texto após a substituição do placeholder.
    if (comissao.tipo === "faturada" && dados.imobiliarias?.length) {
      xml1 = xml1.replace(
        /(<w:t[^>]*>)([^<]*)qual seja,\s*(<\/w:t>)/g,
        (_, open, before, close) => {
          const trimmed = before.trimEnd();
          return trimmed ? `${open}${trimmed}${close}` : "";
        }
      );
    }
    const descontoComp = (comissao.tipo === "destacada" &&
      (comissao.parcela_desconto === "complemento_30" || comissao.parcela_desconto === "complemento_60"))
      ? { parcela: comissao.parcela_desconto, valor: totalComissao }
      : undefined;
    xml1 = substituirPagamento(xml1, parcelas, descontoComp);
    xml1 = substituirComunicacao(xml1, dados);

    xml2 = addPageBreakBefore(xml2, "E por assim se acharem");
    xml2 = substituir(xml2, {
      "«ASS_1»":           ass1,
      "«ASS_2»":           ass2,
      "«Data_Assinatura»": dataExtenso(dados.data_assinatura || ""),
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

    const footerKeys = Object.keys(zipBase).filter(k =>
      k.startsWith("word/footer") && k.endsWith(".xml")
    );

    // Sempre: NUMPAGES → SECTIONPAGES em todos os footers (conta páginas por seção)
    for (const key of footerKeys) {
      let f = strFromU8(zipBase[key]);
      if (f.includes("NUMPAGES")) {
        f = f.replace(/\bNUMPAGES\b/g, "SECTIONPAGES");
        zipBase[key] = strToU8(f);
      }
    }

    // Só para templates com "do Quadro-Resumo": garante footer do corpo sem esse texto
    // e atualiza rels + sectPr do corpo para apontarem para o footer correto
    const quadroKey = footerKeys.find(k =>
      strFromU8(zipBase[k]).includes("do Quadro-Resumo")
    );
    if (quadroKey) {
      // Descobre o rId do footer do quadro nas relações
      const relsKey  = "word/_rels/document.xml.rels";
      let   relsXml  = zipBase[relsKey] ? strFromU8(zipBase[relsKey]) : "";
      const quadroFileName = quadroKey.replace("word/", ""); // ex: "footer1.xml"
      const quadroRIdMatch = relsXml.match(
        new RegExp(`Id="(rId\\d+)"[^>]*Target="${quadroFileName}"`)
      );

      // Cria/sobrescreve footer do corpo a partir do footer do quadro (sem "do Quadro-Resumo")
      // Sempre sobrescreve — o template AAZ já tem footer2.xml mas com valores hardcoded
      const numQuadro  = parseInt(quadroKey.replace("word/footer", "").replace(".xml", "")) || 1;
      const corpoLocal = `footer${numQuadro + 1}.xml`;
      const corpoKey   = `word/${corpoLocal}`;
      const corpoIsNew = !zipBase[corpoKey];

      let fCorpo = strFromU8(zipBase[quadroKey]);
      fCorpo = fCorpo
        .replace(/<w:r[^>]*><w:t[^>]*> do Quadro-Resumo<\/w:t><\/w:r>/g, "")
        .replace(/ do Quadro-Resumo/g, "");
      zipBase[corpoKey] = strToU8(fCorpo);

      if (corpoIsNew) {
        // Arquivo era novo: adiciona Content_Types e relação
        const ctKey = "[Content_Types].xml";
        if (zipBase[ctKey]) {
          let ct = strFromU8(zipBase[ctKey]);
          const footerCT = "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml";
          if (!ct.includes(corpoLocal)) {
            ct = ct.replace("</Types>",
              `<Override PartName="/word/${corpoLocal}" ContentType="${footerCT}"/></Types>`);
            zipBase[ctKey] = strToU8(ct);
          }
        }

        // Adiciona relação para o novo footer e descobre o novo rId
        const rIdNums  = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1]));
        const newRId   = `rId${Math.max(0, ...rIdNums) + 1}`;
        const footerType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer";
        relsXml = relsXml.replace("</Relationships>",
          `<Relationship Id="${newRId}" Type="${footerType}" Target="${corpoLocal}"/></Relationships>`);
        zipBase[relsKey] = strToU8(relsXml);

        // Atualiza o sectPr do corpo (último no documento) para referenciar o novo footer
        // O corpo usa o quadroRId → troca pelo newRId
        if (quadroRIdMatch) {
          const quadroRId = quadroRIdMatch[1];
          let docXml = strFromU8(zipBase["word/document.xml"]);
          const lastSPIdx = docXml.lastIndexOf("<w:sectPr");
          const lastSPEnd = docXml.indexOf("</w:sectPr>", lastSPIdx);
          if (lastSPIdx !== -1 && lastSPEnd !== -1) {
            const spLen    = lastSPEnd + "</w:sectPr>".length;
            let   corpoSP  = docXml.substring(lastSPIdx, spLen);
            corpoSP = corpoSP.replace(
              new RegExp(`(<w:footerReference[^>]*r:id=")${quadroRId}(")`,"g"),
              `$1${newRId}$2`
            );
            zipBase["word/document.xml"] = strToU8(
              docXml.substring(0, lastSPIdx) + corpoSP + docXml.substring(spLen)
            );
          }
        }
      }
    }

    const newZip    = zipBase;
    const docxBytes = zipSync(newZip);

    // ─── Retornar arquivo
    const filename        = `${dados.sigla || ""} ${dados.unidade || ""} - Contrato Promessa de Compra e Venda.docx`.trim();
    const safeFilename    = filename.replace(/[^\w\s\-\.]/g, "_");
    const encodedFilename = encodeURIComponent(safeFilename);

    // ─── Upload do arquivo gerado no Storage
    const year = new Date().getFullYear();
    const ts   = Date.now();
    const storagePath = `${dados.sigla}/${year}/${dados.unidade}-${ts}.docx`;
    let savedPath = "";
    try {
      await supabase.storage.createBucket("contratos", { public: false }).catch(() => {});
      const { error: upErr } = await supabase.storage
        .from("contratos")
        .upload(storagePath, docxBytes, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          upsert: false,
        });
      if (upErr) console.error("Storage upload error:", upErr.message);
      else savedPath = storagePath;
    } catch (e) {
      console.error("Storage upload failed:", e);
    }

    // ─── Salvar histórico
    // 🔒 SEGURANÇA [VULN-14]: registrar user_id para trilha de auditoria
    const { error: histErr } = await supabase.from("historico_contratos").insert({
      sigla:         dados.sigla || "",
      bloco:         dados.bloco || "",
      unidade:       dados.unidade || "",
      comprador:     ass1,
      tipo_comissao: comissao.tipo,
      valor_total:   preco,
      nome_arquivo:  filename,
      storage_path:  savedPath,
      user_id:       userId,
      user_email:    userEmail,
    });
    if (histErr) {
      console.error("AUDIT_FAIL: histórico não salvo para usuário", userId, histErr.message);
    }

    return new Response(docxBytes, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`,
        ...corsHeaders,
      },
    });

  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: "Erro interno" }),
      { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
    );
  }
});
