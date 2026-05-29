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
  "«Data_Assinatura»", "«FORMA_DE_ASSINATURA»",
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
  estado_civil?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
  relacao: "casado" | "união estável";
  regime?: string;
  data_escritura?: string;
}

interface OABSlot {
  numero: string;
  seccional?: string;
  data_emissao?: string;
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
  endereco?: string;
  oab?: OABSlot;
  doc_tipo?: string;
  parceiro?: ParceiroSlot;
}

interface RepresentanteSlot {
  nome: string;
  cpf?: string;
  sexo?: string;
  nacionalidade?: string;
  profissao?: string;
  estado_civil?: string;
  rg?: string;
  orgao_emissor?: string;
  data_emissao?: string;
}

interface PJSlot {
  tipo: "PJ";
  razao_social: string;
  cnpj?: string;
  endereco_pj?: string;
  representantes?: RepresentanteSlot[];
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
  vias_fisicas?: number;
  corretores?: Corretor[];
  imobiliarias?: Imobiliaria[];
  parcela_desconto_manual?: string;
  sem_comissao?: boolean;
  // Quando true, valida CPF/CNPJ por formato mas NÃO bloqueia dígito verificador
  // inválido (caso de uso: testes com documentos fictícios). Server loga warning
  // com user_email para auditoria.
  bypass_documento_invalido?: boolean;
}

// ─── EMPREENDIMENTOS ─────────────────────────────────────────────────────────
// Templates são resolvidos pelas colunas da tabela `empreendimentos`.
// Fallback para convenção de nome caso as colunas estejam vazias:
// "[SIGLA] contrato_cabeca.docx", "[SIGLA] corpo_cabeca.docx", etc.

interface EmpTemplates {
  template_contrato_destacada?: string | null;
  template_corpo_destacada?: string | null;
  template_contrato_cabeca_avista?: string | null;
  template_contrato_faturada?: string | null;
  template_corpo_faturada?: string | null;
  template_contrato_semcomissao?: string | null;
  template_corpo_semcomissao?: string | null;
  template_contrato_semcomissao_avista?: string | null;
}

// Lógica de templates (4 casos):
//   destacada + regular   → contrato_cabeca          + corpo_cabeca
//   destacada + avista    → contrato_cabeca_avista    + corpo_cabeca
//   faturada  (imobiliária) → contrato_faturado       + corpo_faturado
//   semcomissao + regular → contrato_semcomissao      + corpo_semcomissao
//   semcomissao + avista  → contrato_semcomissao_avista + corpo_semcomissao
function getTemplates(sigla: string, tipo: string, avista = false, semComissao = false, emp?: EmpTemplates) {
  const s = sigla?.toUpperCase();
  if (tipo === "destacada") {
    return {
      contrato: avista
        ? emp?.template_contrato_cabeca_avista || `${s} contrato_cabeca_avista.docx`
        : emp?.template_contrato_destacada || `${s} contrato_cabeca.docx`,
      corpo: emp?.template_corpo_destacada || `${s} corpo_cabeca.docx`,
    };
  }
  if (semComissao) {
    return {
      contrato: avista
        ? emp?.template_contrato_semcomissao_avista || `${s} contrato_semcomissao_avista.docx`
        : emp?.template_contrato_semcomissao || `${s} contrato_semcomissao.docx`,
      corpo: emp?.template_corpo_semcomissao || `${s} corpo_semcomissao.docx`,
    };
  }
  // faturada — comissão paga pela imobiliária
  return {
    contrato: emp?.template_contrato_faturada || `${s} contrato_faturado.docx`,
    corpo: emp?.template_corpo_faturada || `${s} corpo_faturado.docx`,
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

// Avança uma data BR (DD/MM/AAAA) em N meses preservando o dia.
// Retorna "" se a data for inválida ou se o dia "transbordar" pro mês seguinte (ex.: 31/01 + 1 mês).
function nextMonthDateBR(dataBR: string, monthsAhead: number): string {
  const parts = parseDateParts(dataBR);
  if (!parts) return "";
  const dt = new Date(Date.UTC(parts.y, parts.m - 1 + monthsAhead, parts.d));
  if (dt.getUTCDate() !== parts.d) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(dt.getUTCDate())}/${pad(dt.getUTCMonth() + 1)}/${dt.getUTCFullYear()}`;
}

// Mensal / semestral / anual: agrupa parcelas adjacentes idênticas em sequência natural
// (mês+1 / mês+6 / ano+1). Complemento NÃO entra aqui — segue caminho próprio.
function podeAgruparMSA(a: Parcela, b: Parcela): boolean {
  if (a.tipo !== b.tipo) return false;
  if (a.tipo !== "mensal" && a.tipo !== "semestral" && a.tipo !== "anual") return false;
  if (a.valor !== b.valor) return false;
  if ((a.reajustavel !== false) !== (b.reajustavel !== false)) return false;
  const gap = a.tipo === "anual" ? 12 : a.tipo === "semestral" ? 6 : 1;
  const proxData = nextMonthDateBR(a.data || "", gap * (a.qtd || 1));
  return !!proxData && proxData === (b.data || "");
}

function agruparConsecutivas(parcelas: Parcela[]): Parcela[] {
  const result: Parcela[] = [];
  for (const p of parcelas) {
    const last = result[result.length - 1];
    if (last && podeAgruparMSA(last, p)) {
      result[result.length - 1] = { ...last, qtd: (last.qtd || 1) + (p.qtd || 1) };
    } else {
      result.push({ ...p });
    }
  }
  return result;
}

// Agrupa parcelas mensal/semestral/anual com qty=1 cada, mesma reajustabilidade
// e gap regular entre datas (1/6/12 meses) — mesmo com valores DIFERENTES.
// Retorna lista de "blocos lógicos": cada bloco é 1 ou mais parcelas relacionadas.
// Complemento NUNCA entra aqui — segue caminho próprio via emitirComplemento.
function agruparPeriodicosDiferentes(parcelasAg: Parcela[]): Parcela[][] {
  const blocos: Parcela[][] = [];
  let i = 0;
  while (i < parcelasAg.length) {
    const p = parcelasAg[i];
    const elegivel = (p.tipo === "mensal" || p.tipo === "semestral" || p.tipo === "anual") && (p.qtd || 1) === 1;
    if (!elegivel) {
      blocos.push([p]);
      i++;
      continue;
    }
    const gap = p.tipo === "anual" ? 12 : p.tipo === "semestral" ? 6 : 1;
    const grupo: Parcela[] = [p];
    let j = i + 1;
    while (j < parcelasAg.length) {
      const next = parcelasAg[j];
      if (next.tipo !== p.tipo) break;
      if ((next.qtd || 1) !== 1) break;
      if ((next.reajustavel !== false) !== (p.reajustavel !== false)) break;
      const lastData = grupo[grupo.length - 1].data || "";
      const esperada = nextMonthDateBR(lastData, gap);
      if (!esperada || esperada !== (next.data || "")) break;
      grupo.push(next);
      j++;
    }
    blocos.push(grupo);
    i = j;
  }
  return blocos;
}

// Expande complementos em lista lógica de parcelas individuais
// (cobre 1 linha qty=2 ou 2 linhas qty=1).
function expandirComplementos(comps: Parcela[]): { valor: number; data: string; reajustavel: boolean }[] {
  const out: { valor: number; data: string; reajustavel: boolean }[] = [];
  for (const c of comps) {
    const qty = c.qtd || 1;
    let curData = c.data || "";
    for (let i = 0; i < qty; i++) {
      out.push({ valor: c.valor, data: curData, reajustavel: c.reajustavel !== false });
      curData = nextMonthDateBR(curData, 1) || curData;
    }
  }
  return out;
}

// Complemento de sinal sempre vai em 1 texto único (mesmo com valores diferentes).
function emitirComplemento(logicos: { valor: number; data: string; reajustavel: boolean }[]): string {
  const n = logicos.length;
  if (n === 0) return "";
  const reaj     = logicos[0].reajustavel ? "reajustáveis" : "fixas";
  const reajUnit = logicos[0].reajustavel ? "reajustável" : "fixa";
  const total    = logicos.reduce((s, l) => s + l.valor, 0);
  const data1    = logicos[0].data || "";

  if (n === 1) {
    const v = logicos[0].valor;
    return `R$${formatar(v)} (${extenso(v)}) serão pagos em 1 parcela ${reajUnit}, mensal, ` +
      `no valor de R$${formatar(v)} (${extenso(v)}) com vencimento em ${data1} ("Parcelas de Complemento de Sinal");`;
  }

  const todosIguais = logicos.every(l => l.valor === logicos[0].valor);
  if (todosIguais) {
    const v = logicos[0].valor;
    const demais      = n === 2 ? "a outra" : "as demais";
    const subsequente = n === 2 ? "no mesmo dia do mês subsequente" : "no mesmo dia dos meses subsequentes";
    return `R$${formatar(total)} (${extenso(total)}) serão pagos em ${n} parcelas ${reaj}, mensais, sucessivas, ` +
      `no valor de R$${formatar(v)} (${extenso(v)}) cada uma delas, ` +
      `vencendo-se a primeira no dia ${data1} e ${demais} ${subsequente} ("Parcelas de Complemento de Sinal");`;
  }

  // Valores distintos — caso típico n=2 (abatimento de comissão destacada em complemento).
  if (n === 2) {
    const [val1, val2] = [logicos[0].valor, logicos[1].valor];
    return `R$${formatar(total)} (${extenso(total)}) serão pagos em 2 (duas) parcelas ${reaj}, ` +
      `mensais, sucessivas, a primeira no valor de R$${formatar(val1)} (${extenso(val1)}) ` +
      `vencendo-se a primeira no dia ${data1} e a outra no valor de R$${formatar(val2)} ` +
      `(${extenso(val2)}) no mesmo dia do mês subsequente ("Parcelas de Complemento de Sinal");`;
  }

  // Fallback 3+ complementos com valores distintos (não ocorre em produção): lista cada um.
  const partes = logicos.map(l => `R$${formatar(l.valor)} (${extenso(l.valor)}) em ${l.data}`).join("; ");
  return `R$${formatar(total)} (${extenso(total)}) serão pagos em ${n} parcelas ${reaj}, mensais, sucessivas: ` +
    `${partes} ("Parcelas de Complemento de Sinal");`;
}

// Emite 1 parágrafo único para grupo de parcelas mensal/semestral/anual com qty=1 cada
// e valores possivelmente DIFERENTES, mas com gap regular entre datas.
// Complemento NÃO entra aqui — segue caminho próprio via emitirComplemento.
function emitirGrupoPeriodico(parcelas: Parcela[], tipo: string, descricao: string): string {
  // Guard defensivo: complemento NUNCA chega aqui (segue emitirComplemento)
  if (tipo === "complemento") return "";

  const n = parcelas.length;
  if (n === 0) return "";

  const reaj  = parcelas[0].reajustavel !== false ? "reajustáveis" : "fixas";
  const total = parcelas.reduce((s, p) => s + p.valor, 0);
  const data1 = parcelas[0].data || "";

  let period: string;
  let subsequente: string;
  // n=2 usa concordância singular ("ano/mês subsequente"); n>=3 usa listagem com datas (não usa este campo).
  if (tipo === "anual") {
    period = "anuais";
    subsequente = n === 2 ? "no mesmo dia do ano subsequente" : "no mesmo dia dos anos subsequentes";
  } else if (tipo === "semestral") {
    period = "semestrais";
    subsequente = "no mesmo dia de seis em seis meses";
  } else { // mensal
    period = "mensais";
    subsequente = n === 2 ? "no mesmo dia do mês subsequente" : "no mesmo dia dos meses subsequentes";
  }

  if (n === 2) {
    const [v1, v2] = [parcelas[0].valor, parcelas[1].valor];
    return `R$${formatar(total)} (${extenso(total)}) serão pagos em 2 (duas) parcelas ${reaj}, ${period}, sucessivas, ` +
      `a primeira no valor de R$${formatar(v1)} (${extenso(v1)}) com vencimento em ${data1} ` +
      `e a outra no valor de R$${formatar(v2)} (${extenso(v2)}) ${subsequente} ("${descricao}");`;
  }

  // n >= 3: lista cada parcela com sua data
  const numerais: Record<number, string> = { 3:"três", 4:"quatro", 5:"cinco", 6:"seis", 7:"sete", 8:"oito", 9:"nove", 10:"dez" };
  const numeralExt = numerais[n] || String(n);
  const partes = parcelas.map(p => `R$${formatar(p.valor)} (${extenso(p.valor)}) em ${p.data || ""}`).join("; ");
  return `R$${formatar(total)} (${extenso(total)}) serão pagos em ${n} (${numeralExt}) parcelas ${reaj}, ${period}, sucessivas: ${partes} ("${descricao}");`;
}

function linhasPagamento(parcelas: Parcela[], descontoComp?: { parcela: string; valor: number }): string[] {
  const textos: string[] = [];
  const temDescontoComp = descontoComp?.parcela === "complemento_30" || descontoComp?.parcela === "complemento_60";

  // Agrupa mensais/semestrais/anuais consecutivas; complemento segue caminho próprio.
  const parcelasAg = agruparConsecutivas(parcelas);

  const comps = parcelasAg.filter(p => p.tipo === "complemento");
  const compsLogicos = expandirComplementos(comps);
  if (temDescontoComp && compsLogicos.length >= 2) {
    const comissao = descontoComp!.valor;
    if (descontoComp!.parcela === "complemento_30") {
      compsLogicos[0].valor = Math.max(0, compsLogicos[0].valor - comissao);
    } else {
      compsLogicos[1].valor = Math.max(0, compsLogicos[1].valor - comissao);
    }
  }

  // Agrupa periódicos (mensal/semestral/anual) qty=1 com gap regular em "blocos lógicos"
  // — mesmo com valores diferentes (caso típico: 2 semestrais intermediárias R$50k + R$80k).
  const blocosLogicos = agruparPeriodicosDiferentes(parcelasAg);

  // Complemento sempre vai em 1 bloco único — não conta pra sufixo romano.
  // Contagem é por BLOCO LÓGICO (um grupo de 2 semestrais conta como 1 bloco).
  const contagem: Record<string, number> = {};
  for (const bloco of blocosLogicos) {
    const tipo = bloco[0].tipo;
    if (tipo === "ato") continue;
    if (tipo === "complemento") continue;
    contagem[tipo] = (contagem[tipo] || 0) + 1;
  }
  const indice: Record<string, number> = {};
  const sufixo = (tipo: string): string => {
    if ((contagem[tipo] || 0) <= 1) return "";
    indice[tipo] = (indice[tipo] || 0) + 1;
    return ` ${ROMANOS[indice[tipo] - 1] ?? indice[tipo]}`;
  };

  let compEmitido = false;
  for (const bloco of blocosLogicos) {
    // Grupo periódico com valores diferentes (2+ parcelas mensal/semestral/anual)
    if (bloco.length > 1) {
      const tipo = bloco[0].tipo;
      // NUNCA chega aqui com complemento (agruparPeriodicosDiferentes só agrupa mensal/semestral/anual)
      let baseDescGrupo: string;
      if (tipo === "anual")          baseDescGrupo = "Parcelas Anuais";
      else if (tipo === "semestral") baseDescGrupo = "Parcelas Semestrais";
      else                           baseDescGrupo = "Parcelas Mensais";
      const descricao = baseDescGrupo + sufixo(tipo);
      textos.push(emitirGrupoPeriodico(bloco, tipo, descricao));
      continue;
    }

    const p = bloco[0];
    if (p.tipo === "ato") continue;

    if (p.tipo === "complemento") {
      if (!compEmitido && compsLogicos.length > 0) {
        compEmitido = true;
        textos.push(emitirComplemento(compsLogicos));
      }
      continue;
    }

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
        `R$${valorUnit} (${extenso(p.valor)}) serão pagos em uma única ` +
        `parcela ${reajUnit} com vencimento em ${data} ("${label}");`
      );
      continue;
    }

    if (qtd === 1) {
      const reajUnit = p.reajustavel !== false ? "reajustável" : "fixa";
      let periodSing: string;
      let baseDescSing: string;
      if (p.tipo === "anual")           { periodSing = "anual";     baseDescSing = "Parcelas Anuais"; }
      else if (p.tipo === "semestral")  { periodSing = "semestral"; baseDescSing = "Parcelas Semestrais"; }
      else                              { periodSing = "mensal";    baseDescSing = "Parcelas Mensais"; }
      const descSing = baseDescSing + sufixo(p.tipo);
      textos.push(
        `R$${valorTot} (${extenso(total)}) serão pagos em 1 parcela ${reajUnit}, ` +
        `${periodSing}, no valor de R$${valorUnit} (${extenso(p.valor)}) com vencimento em ${data} ("${descSing}");`
      );
      continue;
    }

    let baseDescricao: string, period: string, subsequente: string;
    const demais = qtd === 2 ? "a outra" : "as demais";
    if      (p.tipo === "mensal")    { baseDescricao = "Parcelas Mensais";    period = "mensais";    subsequente = qtd === 2 ? "no mesmo dia do mês subsequente" : "no mesmo dia dos meses subsequentes"; }
    else if (p.tipo === "anual")     { baseDescricao = "Parcelas Anuais";     period = "anuais";     subsequente = qtd === 2 ? "no mesmo dia do ano subsequente" : "no mesmo dia dos anos subsequentes"; }
    else if (p.tipo === "semestral") { baseDescricao = "Parcelas Semestrais"; period = "semestrais"; subsequente = "no mesmo dia de seis em seis meses"; }
    else                             { baseDescricao = "Parcelas";            period = "mensais";    subsequente = qtd === 2 ? "no mesmo dia do mês subsequente" : "no mesmo dia dos meses subsequentes"; }

    const descricao = baseDescricao + sufixo(p.tipo);

    textos.push(
      `R$${valorTot} (${extenso(total)}) serão pagos em ${qtd} parcelas ` +
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

  // Extrai <w:pPr> para reutilizar em cada novo parágrafo (remove numPr para não duplicar numeração)
  const pPrMatch = paraOrig.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/);
  const pPrRaw   = pPrMatch ? pPrMatch[0] : "";
  const pPr      = pPrRaw;

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
    // Ajusta hanging indent pra caber romanos longos como (vii)/(viii)/(xviii).
    // 720 twentieths = ~12.7mm — espaço suficiente pra qualquer romano até (xx).
    if (pPrComEspaco.includes("<w:ind")) {
      // Atualiza w:hanging existente; se nao tem, adiciona
      pPrComEspaco = pPrComEspaco.replace(/<w:ind\b([^/]*?)\/>/, (m, attrs) => {
        let a = attrs;
        if (/w:hanging="/.test(a)) {
          a = a.replace(/w:hanging="\d+"/, 'w:hanging="720"');
        } else {
          a += ' w:hanging="720"';
        }
        if (!/w:left="/.test(a)) {
          a += ' w:left="720"';
        }
        return `<w:ind${a}/>`;
      });
    } else {
      pPrComEspaco = pPrComEspaco.replace("</w:pPr>",
        '<w:ind w:left="720" w:hanging="720"/></w:pPr>');
    }
  }

  // Gera um parágrafo por linha de pagamento
  // numPr é mantido do pPr original — o Word numera automaticamente com (i), (ii), (iii)...
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
  const slot0 = dados.slots?.[0];
  const atNome = slot0
    ? (slot0.tipo === "PJ" ? slot0.razao_social : slot0.nome)
    : dados.compradores[0]?.nome;
  if (atNome) linhas.push(`At.: ${escapeXml(atNome)}`);
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

// Valida que dateStr representa uma data real (não "31/02", "2026-13-01" etc).
// Aceita "" (campo opcional vazio). Retorna { d, m, y } parsed ou null.
function parseDateParts(dateStr: string | undefined | null): { d: number; m: number; y: number } | null {
  if (!dateStr) return null;
  let d: number, m: number, y: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const [ys, ms, ds] = dateStr.split("-");
    y = parseInt(ys, 10); m = parseInt(ms, 10); d = parseInt(ds, 10);
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) {
    const [ds, ms, ys] = dateStr.split("/");
    y = parseInt(ys, 10); m = parseInt(ms, 10); d = parseInt(ds, 10);
  } else {
    return null;
  }
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  // Construção real: rejeita 31/02, 30/02, 31/04 etc.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { d, m, y };
}

function isValidDateInput(dateStr: string | undefined | null): boolean {
  if (!dateStr) return true; // vazio é ok (campo opcional)
  return parseDateParts(dateStr) !== null;
}

// ─── Validação de CPF/CNPJ (espelho de utils/formatters.ts do frontend) ────
function validarCPF(cpf: string): boolean {
  const d = cpf.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (len: number): number => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i]) * (len + 1 - i);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(9) === parseInt(d[9]) && calc(10) === parseInt(d[10]);
}

function validarCNPJ(cnpj: string): boolean {
  const d = cnpj.replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (len: number): number => {
    const pesos = len === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += parseInt(d[i]) * pesos[i];
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === parseInt(d[12]) && calc(13) === parseInt(d[13]);
}

// Retorna lista de descrições de documentos inválidos no payload. Só checa
// documentos COMPLETOS (11/14 dígitos) — vazios ou parciais não geram erro.
function getDocsInvalidos(dados: ContratoRequest): string[] {
  const errors: string[] = [];
  if (Array.isArray(dados.slots)) {
    dados.slots.forEach((s, idx) => {
      if (s.tipo === "PJ") {
        const cnpj = (s as PJSlot).cnpj || "";
        if (cnpj.replace(/\D/g, "").length === 14 && !validarCNPJ(cnpj))
          errors.push(`Comprador ${idx + 1} (${(s as PJSlot).razao_social || "PJ"}): CNPJ inválido`);
        ((s as PJSlot).representantes || []).forEach((rep, ri) => {
          const repCpf = rep?.cpf || "";
          if (repCpf.replace(/\D/g, "").length === 11 && !validarCPF(repCpf))
            errors.push(`Comprador ${idx + 1} > Representante ${ri + 1}: CPF inválido`);
        });
      } else {
        const pf = s as PFSlot;
        if ((pf.cpf || "").replace(/\D/g, "").length === 11 && !validarCPF(pf.cpf))
          errors.push(`Comprador ${idx + 1} (${pf.nome || "PF"}): CPF inválido`);
        const parc = pf.parceiro?.cpf || "";
        if (pf.parceiro && parc.replace(/\D/g, "").length === 11 && !validarCPF(parc))
          errors.push(`Comprador ${idx + 1} > Parceiro: CPF inválido`);
      }
    });
  } else if (Array.isArray(dados.compradores)) {
    dados.compradores.forEach((c, idx) => {
      if ((c.cpf || "").replace(/\D/g, "").length === 11 && !validarCPF(c.cpf))
        errors.push(`Comprador ${idx + 1} (${c.nome || ""}): CPF inválido`);
    });
  }
  (dados.imobiliarias || []).forEach((im, idx) => {
    const cn = (im.cnpj || "");
    if (cn.replace(/\D/g, "").length === 14 && !validarCNPJ(cn))
      errors.push(`Imobiliária ${idx + 1} (${im.nome || ""}): CNPJ inválido`);
  });
  (dados.corretores || []).forEach((co, idx) => {
    const doc = (co.cpf_cnpj || "");
    const len = doc.replace(/\D/g, "").length;
    if (len === 11 && !validarCPF(doc))
      errors.push(`Corretor ${idx + 1} (${co.nome || ""}): CPF inválido`);
    if (len === 14 && !validarCNPJ(doc))
      errors.push(`Corretor ${idx + 1} (${co.nome || ""}): CNPJ inválido`);
  });
  return errors;
}

function isoBR(dateStr: string): string {
  if (!dateStr || dateStr.length !== 10) return dateStr;
  // Já em formato BR (DD/MM/YYYY) — retorna como está
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
  const parts = parseDateParts(dateStr);
  if (!parts) return ""; // data inválida → string vazia (validação prévia deve impedir chegar aqui)
  return `${String(parts.d).padStart(2, "0")}/${String(parts.m).padStart(2, "0")}/${parts.y}`;
}

// Aplica concordância de gênero ao estado civil ("solteiro" → "solteira" se F).
// Aceita tanto "solteiro(a)" (placeholder) quanto "solteiro" / "solteira" já gendered.
function genderEstado(estadoCivil: string | undefined, sexo: string | undefined): string {
  if (!estadoCivil) return "";
  const e = estadoCivil.trim().toLowerCase().replace(/\(a\)/g, "");
  if (sexo !== "F") return e;
  return e
    .replace(/\bsolteiro\b/g, "solteira")
    .replace(/\bcasado\b/g, "casada")
    .replace(/\bdivorciado\b/g, "divorciada")
    .replace(/\bviúvo\b/g, "viúva")
    .replace(/\bviuvo\b/g, "viuva");
}

const MESES = ["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"];

function dataExtenso(dateStr: string): string {
  if (!dateStr) return "";
  // Data inválida → string vazia em vez de "31 de fevereiro de 2026" ou
  // "1 de 13 de 2026" no contrato. Validação prévia em validarEntrada
  // deve impedir chegar aqui com lixo.
  const parts = parseDateParts(dateStr);
  if (!parts) return "";
  return `${parts.d} de ${MESES[parts.m - 1]} de ${parts.y}`;
}

// ─── COMPRADORA ──────────────────────────────────────────────────────────────

// estadoCivilAntes=true para união estável (ordem: nac, estado, prof)
// estadoCivilAntes=false (padrão) para demais casos (ordem: nac, prof, estado)
function qualificar(c: Comprador, estadoCivilAntes = true): string {
  // Default: nacionalidade, estado civil, profissão (ordem do gabarito).
  // estadoCivilAntes=false inverte para nacionalidade, profissão, estado civil (mantido por compatibilidade).
  const inscrito = (c.sexo || "M") === "M" ? "inscrito"  : "inscrita";
  const portador = (c.sexo || "M") === "M" ? "portador"  : "portadora";
  const nac      = (c.nacionalidade || "brasileiro(a)").toLowerCase();
  const prof     = (c.profissao || "").trim().toLowerCase();
  const estado   = genderEstado(c.estado_civil, c.sexo);
  const midParts = estadoCivilAntes
    ? [estado, prof].filter(Boolean)
    : [prof, estado].filter(Boolean);
  const cpfStr = `${inscrito} no CPF sob o nº ${c.cpf}`;
  const rgStr_ = c.rg
    ? `${portador} da identidade nº ${c.rg}${c.orgao_emissor ? ` do ${c.orgao_emissor}` : ""}${c.data_emissao ? ` em ${isoBR(c.data_emissao)}` : ""}`
    : "";
  const idParts = [rgStr_, cpfStr].filter(Boolean).join(", ");
  return `${c.nome}, ${nac}, ${midParts.join(", ")}, ${idParts}`;
}

function qualificarSimples(c: { nome: string; nacionalidade?: string; profissao?: string }): string {
  const nac   = (c.nacionalidade || "brasileiro(a)").toLowerCase();
  const prof  = (c.profissao || "").trim().toLowerCase();
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
  const cpfPart = `inscritos no CPF sob os nºs ${c.cpf} e ${conj.cpf}`;
  const rg1 = rgStr(c), rg2 = rgStr(conj);
  let rgPart = "";
  if (rg1 && rg2) rgPart = `portadores das identidades nºs ${rg1} e ${rg2}`;
  else if (rg1)   rgPart = `portador(a) da identidade nº ${rg1}`;
  else if (rg2)   rgPart = `portador(a) da identidade nº ${rg2}`;
  const idParts = [rgPart, cpfPart].filter(Boolean).join(", ");
  return (
    `${qualificarSimples(c)}, e ${conjLabel} ${qualificarSimples(conj)}, ` +
    `casados pelo regime da ${regime.toLowerCase()}, ${idParts}`
  );
}

// ─── QUALIFICAÇÃO PJ ─────────────────────────────────────────────────────────

function qualificarRepresentante(rep: RepresentanteSlot): string {
  const s   = (rep.sexo || "M") === "M" ? "M" : "F";
  const ins  = s === "M" ? "inscrito" : "inscrita";
  const por  = s === "M" ? "portador" : "portadora";
  const nac  = (rep.nacionalidade || (s === "M" ? "brasileiro" : "brasileira")).toLowerCase();
  const estadoStr = genderEstado(rep.estado_civil, rep.sexo);
  const estado = estadoStr ? `, ${estadoStr}` : "";
  const prof = rep.profissao ? `, ${rep.profissao.trim().toLowerCase()}` : "";
  const rg   = rep.rg
    ? `, ${por} da identidade nº ${rep.rg}${rep.orgao_emissor ? ` do ${rep.orgao_emissor}` : ""}${rep.data_emissao ? ` em ${isoBR(rep.data_emissao)}` : ""}`
    : "";
  const cpfR = rep.cpf ? `, ${ins} no CPF sob o nº ${rep.cpf}` : "";
  return `${rep.nome}, ${nac}${estado}${prof}${rg}${cpfR}`;
}

function qualificarPJ(slot: PJSlot): string {
  const cnpj = slot.cnpj ? `, pessoa jurídica inscrita no CNPJ sob o nº ${slot.cnpj}` : "";
  const sede  = slot.endereco_pj ? `, com sede à ${slot.endereco_pj}` : "";
  const reps = (slot.representantes || []).filter((r) => r?.nome);
  let repPart = "";
  if (reps.length === 1) {
    repPart = `, neste ato representada por seu representante legal ${qualificarRepresentante(reps[0])}`;
  } else if (reps.length > 1) {
    const partes = reps.map(qualificarRepresentante);
    const ultimo = partes.pop();
    repPart = `, neste ato representada por seus representantes legais ${partes.join(", ")}, e ${ultimo}`;
  }
  return `${slot.razao_social}${cnpj}${sede}${repPart}`;
}

// ─── QUALIFICAÇÃO PF COM PARCEIRO ─────────────────────────────────────────────

// ─── HELPERS PARA UNIÃO ESTÁVEL ──────────────────────────────────────────────

function genderStem(s: string): string {
  if (!s) return "";
  const first = s.toLowerCase().trim().split(/\s+/)[0];
  return first.replace(/[ao]$/, "");
}

function pluralizeWord(word: string): string {
  if (!word) return word;
  const w = word.toLowerCase();
  if (w.endsWith("ão")) return word.slice(0, -2) + "ões";
  if (w.endsWith("m")) return word.slice(0, -1) + "ns";
  if (w.endsWith("l")) {
    if (/[aeiou]l$/.test(w)) return word.slice(0, -1) + "is";
    return word + "es";
  }
  if (/[rzs]$/.test(w)) return word + "es";
  return word + "s";
}

function pluralizeFirstWord(phrase: string): string {
  if (!phrase) return phrase;
  const parts = phrase.split(/\s+/);
  parts[0] = pluralizeWord(parts[0]);
  return parts.join(" ");
}

function pickMasc(s1: string, s2: string, sexo1?: string, sexo2?: string): string {
  if (sexo1 === "M") return s1;
  if (sexo2 === "M") return s2;
  return s1 || s2;
}

// Multi-slot união estável: formato do gabarito (drops data da escritura do texto)
function qualificarUniaoEstavelMultiSlot(c: Comprador, p2: Comprador, regime: string): string {
  const estado1 = genderEstado(c.estado_civil, c.sexo);
  const estado2 = genderEstado(p2.estado_civil, p2.sexo);

  const nac1 = (c.nacionalidade || "brasileiro").toLowerCase();
  const nac2 = (p2.nacionalidade || "brasileira").toLowerCase();
  const prof1 = (c.profissao || "").trim().toLowerCase();
  const prof2 = (p2.profissao || "").trim().toLowerCase();

  const sameNac = genderStem(nac1) === genderStem(nac2);
  const sameProf = !!prof1 && !!prof2 && genderStem(prof1) === genderStem(prof2);

  let header: string;
  if (sameNac && sameProf) {
    const nac = pickMasc(nac1, nac2, c.sexo, p2.sexo);
    const prof = pickMasc(prof1, prof2, c.sexo, p2.sexo);
    const namePart = `${c.nome}${estado1 ? ", " + estado1 : ""}, e ${p2.nome}${estado2 ? ", " + estado2 : ""}`;
    header = `${namePart}, ${pluralizeFirstWord(nac)}, ${pluralizeFirstWord(prof)}`;
  } else {
    const part1 = `${c.nome}${estado1 ? ", " + estado1 : ""}, ${nac1}${prof1 ? ", " + prof1 : ""}`;
    const part2 = `${p2.nome}${estado2 ? ", " + estado2 : ""}, ${nac2}${prof2 ? ", " + prof2 : ""}`;
    header = `${part1}, e ${part2}`;
  }

  const regimePart = regime ? ` pelo regime da ${regime.toLowerCase()}` : "";
  const middle = `, conviventes em união estável${regimePart}`;

  const rg1 = c.rg, rg2 = p2.rg;
  const d1 = c.data_emissao, d2 = p2.data_emissao;
  const o1 = c.orgao_emissor, o2 = p2.orgao_emissor;

  let rgPart = "";
  if (rg1 && rg2) {
    const sameDate = !!d1 && !!d2 && d1 === d2;
    if (sameDate) {
      rgPart = `, portadores das identidades nºs ${rg1}${o1 ? " do " + o1 : ""} e ${rg2}${o2 ? " do " + o2 : ""}${d1 ? " em " + isoBR(d1) : ""}`;
    } else {
      const p1Rg = `${rg1}${o1 ? " do " + o1 : ""}${d1 ? " em " + isoBR(d1) : ""}`;
      const p2Rg = `${rg2}${o2 ? " do " + o2 : ""}${d2 ? " em " + isoBR(d2) : ""}`;
      rgPart = `, portadores das identidades nºs ${p1Rg} e ${p2Rg}`;
    }
  } else if (rg1) {
    rgPart = `, portador da identidade nº ${rg1}${o1 ? " do " + o1 : ""}${d1 ? " em " + isoBR(d1) : ""}`;
  } else if (rg2) {
    rgPart = `, portador da identidade nº ${rg2}${o2 ? " do " + o2 : ""}${d2 ? " em " + isoBR(d2) : ""}`;
  }

  const cpfPart = `, inscritos no CPF sob os nºs ${c.cpf} e ${p2.cpf}`;

  return header + middle + rgPart + cpfPart;
}

// Sem escritura: "X qualificado, que declara conviver em União Estável com Y qualificado [com REGIME]"
function qualificarUniaoEstavelDeclara(c: Comprador, p2: Comprador, regime: string): string {
  const q1 = qualificar(c);
  const q2 = qualificar(p2);
  const regimePart = regime ? ` com ${regime.toLowerCase()}` : "";
  return `${q1}, que declara conviver em União Estável com ${q2}${regimePart}`;
}

function qualificarPFComParceiro(slot: PFSlot, multiSlot: boolean = false): string {
  const parc = slot.parceiro!;
  const c: Comprador = {
    nome: slot.nome, cpf: slot.cpf, sexo: slot.sexo,
    nacionalidade: slot.nacionalidade, profissao: slot.profissao,
    estado_civil: slot.estado_civil,
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

  // União estável: 2 casos baseados em dataEscritura
  const regime = (parc.regime || "").trim();
  const dataEsc = (parc.data_escritura || "").trim();
  const p2: Comprador = {
    nome: parc.nome, cpf: parc.cpf, sexo: parc.sexo,
    nacionalidade: parc.nacionalidade, profissao: parc.profissao,
    estado_civil: parc.estado_civil,
    rg: parc.rg, orgao_emissor: parc.orgao_emissor, data_emissao: parc.data_emissao,
  };

  if (dataEsc) {
    // Caso 1: com escritura
    if (multiSlot) {
      // Multi-slot: gabarito format (drops data da escritura do texto)
      return qualificarUniaoEstavelMultiSlot(c, p2, regime);
    }
    // Single-slot: (1)/(2) format com "conviver"
    return (
      `(1) ${qualificar(c)}; e (2) ${qualificar(p2)}, ` +
      `que declaram em ${dataExtenso(dataEsc)} através de Escritura de União Estável ` +
      `conviver sob o regime de ${regime.toLowerCase() || "comunhão parcial de bens"}`
    );
  }

  // Caso 2: sem escritura → "declara conviver"
  return qualificarUniaoEstavelDeclara(c, p2, regime);
}

// ─── MONTAR COMPRADORA A PARTIR DE SLOTS ──────────────────────────────────────

function montarCompradoraFromSlots(dados: ContratoRequest): string {
  const slots = dados.slots!;

  // Collect per-PF addresses; PJ addresses are always embedded inline via qualificarPJ
  const pfAddresses = slots
    .filter((s) => s.tipo === "PF")
    .map((s) => ((s as PFSlot).endereco || "").trim());
  const uniquePfAddrs = [...new Set(pfAddresses.filter(Boolean))];

  // "shared at end" só faz sentido pra single-slot OU quando TODOS os PFs têm exatamente
  // o mesmo endereço (e existe pelo menos um). Em multi-slot misto (alguns sem endereço,
  // ou com endereços diferentes, ou misturado com PJ), cada PF carrega seu endereço inline.
  const isMultiSlot = slots.length > 1;
  const allPfsHaveSameAddr = uniquePfAddrs.length === 1
    && pfAddresses.every((a) => !!a);
  const useSharedAtEnd = !isMultiSlot || allPfsHaveSameAddr;
  const sharedAddr = uniquePfAddrs[0] || (dados.endereco || "").trim();

  const parts = slots.map((slot) => {
    if (slot.tipo === "PJ") return qualificarPJ(slot as PJSlot);

    const pf = slot as PFSlot;
    const hasPartner = !!pf.parceiro;
    const pfAddr = (pf.endereco || "").trim();

    const docTipo = pf.doc_tipo || "";
    const ins = (pf.sexo || "M") === "F" ? "inscrita" : "inscrito";
    let docText = "";
    if (docTipo === "OAB" && pf.rg) {
      const sec = (pf.orgao_emissor || "").replace(/^OAB\//i, "");
      docText = `, ${ins} na OAB${sec ? `/${sec}` : ""} sob o nº ${pf.rg}`;
    } else if (docTipo === "CRM" && pf.rg) {
      const sec = (pf.orgao_emissor || "").replace(/^CRM\//i, "");
      docText = `, ${ins} no CRM${sec ? `/${sec}` : ""} sob o nº ${pf.rg}`;
    } else if (!docTipo && pf.oab?.numero) {
      docText = `, ${ins} na OAB/${pf.oab.seccional || ""} sob o nº ${pf.oab.numero}`;
    }

    // For OAB/CRM: suppress "portador da identidade" — number already in docText
    const pfForQualify = (docTipo === "OAB" || docTipo === "CRM")
      ? { ...pf, rg: undefined, orgao_emissor: undefined, data_emissao: undefined } as unknown as PFSlot
      : pf;

    const baseText = (hasPartner
      ? qualificarPFComParceiro(pfForQualify, slots.length > 1)
      : qualificar(pfForQualify as unknown as Comprador)) + docText;

    // In "different addresses" mode: append address inline for each PF slot
    if (!useSharedAtEnd && pfAddr) {
      const residente = hasPartner ? "residentes à" : "residente à";
      return `${baseText}, ${residente} ${pfAddr}`;
    }

    return baseText;
  });

  if (parts.length === 1) {
    if (slots[0].tipo === "PJ") {
      return parts[0]; // PJ tem sede embutida via qualificarPJ — não precisa "residente"
    }
    const pf0 = slots[0] as PFSlot;
    const residente = pf0.parceiro ? "residentes à" : "residente à";
    const suffix = sharedAddr ? `, ${residente} ${sharedAddr}` : "";
    return `${parts[0]}${suffix}`;
  }

  const numbered = parts.map((p, i) => `(${i + 1}) ${p}`);
  const last = numbered.pop()!;

  if (useSharedAtEnd && sharedAddr) {
    return `${numbered.join("; ")}; ${last}, residentes à ${sharedAddr}`;
  }

  // Different addresses — each PF already has their address inline
  return `${numbered.join("; ")}; ${last}`;
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
    return `${fmt(compradores[0])}, residente à ${endereco}`;
  }

  const [c1, c2] = compradores;

  // Fluxo legado: dois compradores são o casal (sem conjuge sub-objeto)
  if (relacao === "casado" && !c1.conjuge) {
    const conj = (c2.sexo || "F") === "F" ? "sua mulher" : "seu marido";
    const cpfPart = `inscritos no CPF sob os nºs ${c1.cpf} e ${c2.cpf}`;
    const rg1 = rgStr(c1), rg2 = rgStr(c2);
    let rgPart = "";
    if (rg1 && rg2) rgPart = `portadores das identidades nºs ${rg1} e ${rg2}`;
    else if (rg1)   rgPart = `portador(a) da identidade nº ${rg1}`;
    else if (rg2)   rgPart = `portador(a) da identidade nº ${rg2}`;
    const idParts = [rgPart, cpfPart].filter(Boolean).join(", ");
    return (
      `${qualificarSimples(c1)}, e ${conj} ${qualificarSimples(c2)}, ` +
      `casados pelo regime da ${regime.toLowerCase()}, ${idParts}, ` +
      `residentes à ${endereco}`
    );
  }

  if (relacao === "união estável") {
    const regimePart    = regime ? ` com ${regime.toLowerCase()}` : "";
    const dataEscritura = dados.data_escritura ? ` assinada em ${isoBR(dados.data_escritura)}` : "";
    return (
      `(1) ${qualificar(c1, true)}; e (2) ${qualificar(c2, true)}, residentes à ${endereco}, ` +
      `ambos declaram viver em união estável${regimePart} através de escritura pública declaratória${dataEscritura}, ` +
      `independentemente de gênero e número, sendo ambos solidariamente responsáveis e representantes entre si`
    );
  }

  // Dois compradores independentes, cada um possivelmente com cônjuge
  return `(1) ${fmt(c1)}; e (2) ${fmt(c2)}, residentes à ${endereco}`;
}

// ─── DOCX: SUBSTITUIÇÃO E MERGE ──────────────────────────────────────────────

// Aplica negrito + centralização à linha de cabeçalho da tabela de corretores
// (tr imediatamente antes da linha modelo do «CORRETOR_EMPRESA»).
function boldifyCorretorHeader(xml: string): string {
  const idx = xml.indexOf("«CORRETOR_EMPRESA»");
  if (idx === -1) return xml;
  const modelTrStart = xml.lastIndexOf("<w:tr", idx);
  if (modelTrStart === -1) return xml;
  // Localiza tr anterior (cabeçalho). "<w:tr" tem 5 chars, então o próximo char
  // está no índice +5 (deve ser ">" ou " " — descarta "<w:trPr").
  let headerStart = -1;
  let pos = modelTrStart - 1;
  while (pos > 0) {
    const candidate = xml.lastIndexOf("<w:tr", pos);
    if (candidate === -1) break;
    const ch = xml[candidate + 5];
    if (ch === ">" || ch === " ") { headerStart = candidate; break; }
    pos = candidate - 1;
  }
  if (headerStart === -1 || headerStart >= modelTrStart) return xml;

  let headerXml = xml.substring(headerStart, modelTrStart);
  // Centraliza
  headerXml = headerXml.replace(/<w:jc\b[^>]*\/>/g, '<w:jc w:val="center"/>');
  headerXml = headerXml.replace(/(<w:pPr>)([\s\S]*?)(<\/w:pPr>)/g, (m, open, content, close) =>
    content.includes("<w:jc ") ? m : open + content + '<w:jc w:val="center"/>' + close
  );
  headerXml = headerXml.replace(/(<w:p\b[^>]*>)(?!<w:pPr\b)/g, '$1<w:pPr><w:jc w:val="center"/></w:pPr>');
  // Negrito em todos os runs existentes
  headerXml = headerXml.replace(/(<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g, (m, open, content, close) => {
    if (/<w:b\b/.test(content)) return m;
    return open + content + "<w:b/><w:bCs/>" + close;
  });
  // Adiciona rPr com negrito em runs que não têm
  headerXml = headerXml.replace(/(<w:r\b[^>]*>)(?![\s\S]{0,50}<w:rPr)(<w:t)/g,
    '$1<w:rPr><w:b/><w:bCs/></w:rPr>$2'
  );

  return xml.substring(0, headerStart) + headerXml + xml.substring(modelTrStart);
}

// Localiza runs standalone <w:r>...<w:t>(s)</w:t></w:r> ou <w:t>(m)</w:t> e os
// ajusta com base na quantidade de corretores: singular → remove o run inteiro;
// plural → troca "(s)"/"(m)" por "s"/"m" dentro do run. Esses markers aparecem
// principalmente na seção "DA COMISSÃO DE CORRETAGEM" do template (ex:
// "empresa(s) especializada(s)", "a(s) empresa(s) de venda").
function fixCorretagemPluralMarkers(xml: string, count: number): string {
  const isPlural = count > 1;
  const markerEnd = /<w:t[^>]*>\((s|m)\)<\/w:t><\/w:r>/g;
  type Item = { rStart: number; rEnd: number; letter: string };
  const items: Item[] = [];
  let m: RegExpExecArray | null;
  while ((m = markerEnd.exec(xml)) !== null) {
    const matchPos = m.index;
    // Procura o <w:r> imediato (não <w:rPr> nem <w:rsidR>) antes da posição
    let rStart = -1;
    let search = matchPos;
    while (search > 0) {
      const idx = xml.lastIndexOf("<w:r", search);
      if (idx < 0) break;
      const c = xml[idx + 4];
      if (c === " " || c === ">") {
        const firstClose = xml.indexOf("</w:r>", idx);
        if (firstClose >= matchPos) {
          rStart = idx;
          break;
        }
      }
      search = idx - 1;
    }
    if (rStart >= 0) {
      items.push({ rStart, rEnd: m.index + m[0].length, letter: m[1] });
    }
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (isPlural) {
      const runText = xml.substring(it.rStart, it.rEnd);
      const fixed = runText.replace(`(${it.letter})`, it.letter);
      xml = xml.substring(0, it.rStart) + fixed + xml.substring(it.rEnd);
    } else {
      xml = xml.substring(0, it.rStart) + xml.substring(it.rEnd);
    }
  }
  return xml;
}

function substituirCorretores(xml: string, corretores: Corretor[]): string {
  const total = corretores.reduce((sum, c) => sum + (c.valor || 0), 0);

  // Localiza a linha modelo «CORRETOR_EMPRESA» no template
  const marker = "«CORRETOR_EMPRESA»";
  const idx = xml.indexOf(marker);

  if (idx === -1) {
    // Template sem tabela de corretores (ex: faturado simples)
    return xml.replaceAll("«TOTAL_COMISSAO»", formatar(total));
  }

  // Aplica negrito no cabeçalho antes de qualquer manipulação dos offsets
  xml = boldifyCorretorHeader(xml);
  const idxAfterBold = xml.indexOf(marker);

  // Extrai o <w:tr> completo que contém o marcador
  const trStart = xml.lastIndexOf("<w:tr", idxAfterBold);
  const trEnd   = xml.indexOf("</w:tr>", idxAfterBold) + "</w:tr>".length;
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
  // Adiciona pPr com center em parágrafos que não têm pPr nenhum
  rowNorm = rowNorm.replace(/(<w:p\b[^>]*>)(?!<w:pPr\b)/g, '$1<w:pPr><w:jc w:val="center"/></w:pPr>');
  // Força Calibri 12pt em todos os runs da linha
  rowNorm = rowNorm.replace(/(<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g, (m, open, content, close) =>
    open + content + CALIBRI_12 + close
  );
  // Runs sem rPr: insere rPr com Calibri 12pt antes de <w:t>
  rowNorm = rowNorm.replace(/(<w:r\b[^>]*>)(?![\s\S]{0,50}<w:rPr)(<w:t)/g,
    `$1<w:rPr>${CALIBRI_12}</w:rPr>$2`
  );

  // Gera uma linha por corretor (sem limite fixo). Nome em CAPS na tabela.
  const linhas = corretores.map(c =>
    rowNorm
      .replaceAll("«CORRETOR_EMPRESA»",   escapeXml((c.nome || "").toUpperCase()))
      .replaceAll("«CORRETOR__EMPRESA»",  escapeXml((c.nome || "").toUpperCase()))
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
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Remove negrito de todos os runs do parágrafo que contém o placeholder.
// Usado pra linha "Niterói, «Data_Assinatura»." onde o template tem bold no texto
// estático ("Niterói, ", ".") além do placeholder.
function removeNegritoParagrafo(xml: string, placeholder: string): string {
  const idx = xml.indexOf(placeholder);
  if (idx === -1) return xml;

  // Localiza o <w:p> que contém o placeholder
  let pStart = -1;
  let pos = idx;
  while (pos > 0) {
    const candidate = xml.lastIndexOf("<w:p", pos);
    if (candidate === -1) break;
    const ch = xml[candidate + 4];
    if (ch === ">" || ch === " ") { pStart = candidate; break; }
    pos = candidate - 1;
  }
  if (pStart === -1) return xml;
  const pEnd = xml.indexOf("</w:p>", idx) + "</w:p>".length;
  if (pEnd <= pStart) return xml;

  let para = xml.substring(pStart, pEnd);
  // Remove <w:b/> e <w:bCs/> dos rPr existentes
  para = para.replace(/(<w:rPr>)([\s\S]*?)(<\/w:rPr>)/g, (m, open, content, close) =>
    open + content.replace(/<w:b\b[^>]*\/>/g, "").replace(/<w:bCs\b[^>]*\/>/g, "") + close
  );

  return xml.substring(0, pStart) + para + xml.substring(pEnd);
}

function stripMergeFields(xml: string): string {
  if (!xml.includes("MERGEFIELD")) return xml;
  // Remove instrText elements (field codes like: MERGEFIELD "FIELDNAME" \* MERGEFORMAT)
  xml = xml.replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/g, "");
  // Remove self-closing fldChar elements (begin / separate / end markers)
  xml = xml.replace(/<w:fldChar\b[^/]*\/>/g, "");
  return xml;
}

// Lista de quem assina como COMPRADORA, na ordem dos compradores. Comprador
// casado / em união estável → ele e o cônjuge assinam. PJ assina pela razão
// social (a assinatura é do representante, mas o nome impresso é a empresa).
function listarSignatarios(dados: ContratoRequest): string[] {
  const nomes: string[] = [];
  const slots = dados.slots ?? [];
  if (slots.length) {
    for (const s of slots) {
      if (s.tipo === "PJ") {
        if (s.razao_social) nomes.push(s.razao_social);
      } else {
        if (s.nome) nomes.push(s.nome);
        if (s.parceiro?.nome) nomes.push(s.parceiro.nome);
      }
    }
  } else {
    for (const c of dados.compradores ?? []) {
      if (c.nome) nomes.push(c.nome);
      if (c.conjuge?.nome) nomes.push(c.conjuge.nome);
    }
  }
  return nomes;
}

// Repete o bloco de assinatura do COMPRADOR uma vez por signatário.
// No template a parte da COMPRADORA tem 2 blocos fixos («ASS_1» e «ASS_2»),
// cada um = parágrafo do nome + parágrafo "COMPRADORA" + parágrafo vazio.
// Esta função substitui esses 2 blocos por N, conforme a lista de signatários.
function substituirAssinaturas(xml: string, nomes: string[], tagsAdobe = false): string {
  const idx1 = xml.indexOf("«ASS_1»");
  if (idx1 === -1 || nomes.length === 0) return xml;

  // Início do <w:p> (não <w:pPr>) que contém uma posição.
  const inicioParagrafo = (pos: number): number => {
    let p = pos;
    while (p > 0) {
      const c = xml.lastIndexOf("<w:p", p);
      if (c === -1) return -1;
      const ch = xml[c + 4];
      if (ch === ">" || ch === " ") return c;
      p = c - 1;
    }
    return -1;
  };
  const fimParagrafo = (pos: number): number => {
    const e = xml.indexOf("</w:p>", pos);
    return e === -1 ? -1 : e + "</w:p>".length;
  };

  const pNomeStart = inicioParagrafo(idx1);
  const pNomeEnd   = fimParagrafo(idx1);        // parágrafo do nome «ASS_1»
  if (pNomeStart === -1 || pNomeEnd === -1) return xml;
  const pLabelEnd  = fimParagrafo(pNomeEnd);    // parágrafo "COMPRADORA"
  const pEspEnd    = fimParagrafo(pLabelEnd);   // parágrafo vazio (espaçador)
  if (pLabelEnd === -1 || pEspEnd === -1) return xml;

  const paraNome      = xml.substring(pNomeStart, pNomeEnd);
  const paraLabel     = xml.substring(pNomeEnd, pLabelEnd);
  const paraEspacador = xml.substring(pLabelEnd, pEspEnd);

  // Fim da região fixa: o bloco do 2º comprador, se o template o tiver.
  let regiaoFim = pLabelEnd;
  const idx2 = xml.indexOf("«ASS_2»", pLabelEnd);
  if (idx2 !== -1) {
    const pAss2End = fimParagrafo(idx2);
    const pLabel2End = pAss2End !== -1 ? fimParagrafo(pAss2End) : -1;
    if (pLabel2End !== -1) regiaoFim = pLabel2End;
  }

  // Remove IDs únicos do Word — copiar o mesmo parágrafo N vezes não pode
  // duplicar paraId/textId.
  const limparIds = (p: string): string => p
    .replace(/\s*w14:paraId="[^"]*"/g, "")
    .replace(/\s*w14:textId="[^"]*"/g, "")
    .replace(/\s*w:rsidR="[^"]*"/g, "")
    .replace(/\s*w:rsidRPr="[^"]*"/g, "")
    .replace(/\s*w:rsidRDefault="[^"]*"/g, "");

  const nomeBase  = limparIds(paraNome);
  const labelBase = limparIds(paraLabel);
  const espBase   = limparIds(paraEspacador);

  const blocos = nomes.map((nome, i) => {
    const para = nomeBase.replace("«ASS_1»", () => escapeXml((nome || "").toUpperCase()));
    // Modo Adobe: marcação de assinatura do comprador i (signer i+1) acima do nome.
    const tag = tagsAdobe ? paraTagAssinatura(`comp${i + 1}`, i + 1) : "";
    return tag + para + labelBase + (i < nomes.length - 1 ? espBase + espBase : "");
  }).join("");

  return xml.substring(0, pNomeStart) + blocos + xml.substring(regiaoFim);
}

// ─── MODO ADOBE: marcações (text tags) de assinatura na última página ─────────
// Tag do Adobe Acrobat Sign: {{campo_es_:signerN:signature}} — o Adobe troca por
// um campo de assinatura do signatário N (ordem dos destinatários do acordo).
function tagAdobeSig(field: string, signer: number): string {
  return `{{${field}_es_:signer${signer}:signature}}`;
}
function runTag(field: string, signer: number): string {
  return `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr>`
    + `<w:t xml:space="preserve">${tagAdobeSig(field, signer)}</w:t></w:r>`;
}
// Parágrafo centralizado com uma tag de assinatura (usado acima do nome do comprador).
function paraTagAssinatura(field: string, signer: number): string {
  return `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr></w:pPr>${runTag(field, signer)}</w:p>`;
}
// Início do <w:p> (não <w:pPr>) em/antes de uma posição.
function inicioParaAntes(xml: string, pos: number): number {
  let p = pos;
  while (p > 0) {
    const c = xml.lastIndexOf("<w:p", p);
    if (c === -1) return -1;
    const ch = xml[c + 4];
    if (ch === ">" || ch === " ") return c;
    p = c - 1;
  }
  return -1;
}
// Marca os 2 diretores (lado a lado) acima do nome da VENDEDORA na página de
// assinatura (última ocorrência de "VENDEDORA"). signers numComp+1 e numComp+2.
function marcarDiretores(xml: string, numComp: number): string {
  const labelIdx = xml.lastIndexOf("VENDEDORA</w:t>");
  if (labelIdx === -1) return xml;
  const labelParaStart = inicioParaAntes(xml, labelIdx);
  if (labelParaStart === -1) return xml;
  const empParaStart = inicioParaAntes(xml, labelParaStart - 1); // parágrafo do nome da SPE
  if (empParaStart === -1) return xml;
  const para = `<w:p><w:pPr><w:jc w:val="center"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/></w:rPr></w:pPr>`
    + runTag("dir1", numComp + 1)
    + `<w:r><w:tab/><w:tab/><w:tab/></w:r>`
    + runTag("dir2", numComp + 2)
    + `</w:p>`;
  return xml.substring(0, empParaStart) + para + xml.substring(empParaStart);
}
// Preenche Nome/CPF/Id das 2 testemunhas e marca a assinatura de cada uma.
// signerBase = signer da 1ª testemunha (numComp+3).
function preencherEMarcarTestemunhas(
  xml: string,
  testemunhas: { nome?: string; cpf?: string; rg?: string }[],
  signerBase: number,
): string {
  const ini = xml.indexOf("Testemunhas:");
  if (ini === -1 || testemunhas.length === 0) return xml;
  const head = xml.substring(0, ini);
  let reg = xml.substring(ini);

  // Anexa um valor ao 1º label ainda não preenchido (Nome:/CPF:/Id:).
  const fillNext = (label: string, value: string) => {
    if (!value) return;
    const alvo = `<w:t>${label}</w:t>`;
    const k = reg.indexOf(alvo);
    if (k === -1) return;
    reg = reg.substring(0, k) + `<w:t xml:space="preserve">${label} ${escapeXml(value)}</w:t>` + reg.substring(k + alvo.length);
  };
  // Insere a tag de assinatura logo após o número "N." da testemunha.
  const tagAposNumero = (num: string, field: string, signer: number) => {
    const alvo = `<w:t>${num}</w:t></w:r>`;
    const k = reg.indexOf(alvo);
    if (k === -1) return;
    reg = reg.substring(0, k) + `<w:t>${num}</w:t></w:r><w:r><w:tab/></w:r>` + runTag(field, signer) + reg.substring(k + alvo.length);
  };

  testemunhas.slice(0, 2).forEach((t, i) => {
    const signer = signerBase + i;
    tagAposNumero(`${i + 1}.`, `test${signer}`, signer);
    fillNext("Nome:", t.nome || "");
    fillNext("CPF:", t.cpf || "");
    fillNext("Id:", t.rg || "");
  });

  return head + reg;
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
      // Callback form: evita que `$1`, `$&`, etc. em `safe` (nomes/empresas que
      // contenham `$`) sejam interpretados como referência de captura e
      // corrompam o texto do contrato.
      runNew = runNew.replace(placeholder, () => safe);
      result = result.substring(0, rStart) + runNew + result.substring(rEndFull);
    }
  }
  return result;
}

// Mescla imagens (e rels) do corpo (zip2) no zip1 antes do merge do document.xml.
// Sem isso, a imagem do corpo aparece como "Não é possível exibir esta imagem" no .docx final,
// porque o zipBase usa zip1 como base e perde os media files do zip2.
// Renumera rIds do zip2 que conflitam com zip1 e renomeia arquivos de mídia em caso de colisão.
// Atualiza xml2 com os novos rIds. Modifica zip1 in-place (mídia + rels).
function mesclarMidiasCorpo(
  zip1: Record<string, Uint8Array>,
  zip2: Record<string, Uint8Array>,
  xml2: string
): string {
  const relsKey = "word/_rels/document.xml.rels";
  const baseRelsXml  = zip1[relsKey] ? strFromU8(zip1[relsKey]) : "";
  const corpoRelsXml = zip2[relsKey] ? strFromU8(zip2[relsKey]) : "";
  if (!corpoRelsXml || !baseRelsXml) return xml2;

  // Coleta relationships de imagem do corpo
  const imageRels: Array<{ oldRId: string; target: string }> = [];
  // [^>]*? (lazy) permite que o Target contenha "/" (ex: "media/image1.png")
  const relRegex = /<Relationship\b[^>]*?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = relRegex.exec(corpoRelsXml)) !== null) {
    const relText = m[0];
    const idMatch     = relText.match(/Id="(rId\d+)"/);
    const typeMatch   = relText.match(/Type="([^"]+)"/);
    const targetMatch = relText.match(/Target="([^"]+)"/);
    if (idMatch && typeMatch && targetMatch && typeMatch[1].includes("/image")) {
      imageRels.push({ oldRId: idMatch[1], target: targetMatch[1] });
    }
  }
  if (imageRels.length === 0) return xml2;

  // Próximo rId disponível no zip1
  const baseRIdNums = [...baseRelsXml.matchAll(/Id="rId(\d+)"/g)].map(x => parseInt(x[1]));
  let nextRId = (baseRIdNums.length === 0 ? 0 : Math.max(...baseRIdNums)) + 1;

  // Mídia existente no zip1 (pra evitar colisão de nome)
  const existingMedia = new Set(Object.keys(zip1).filter(k => k.startsWith("word/media/")));

  const IMAGE_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
  let newBaseRels  = baseRelsXml;
  let updatedXml2  = xml2;

  for (const rel of imageRels) {
    const srcPath = `word/${rel.target}`;
    if (!zip2[srcPath]) continue;

    // Gera novo nome de arquivo se colidir
    const oldFilename = rel.target.replace(/^media\//, "");
    let newFilename = oldFilename;
    if (existingMedia.has(`word/media/${newFilename}`)) {
      const lastDot = newFilename.lastIndexOf(".");
      const stem = lastDot >= 0 ? newFilename.substring(0, lastDot) : newFilename;
      const ext  = lastDot >= 0 ? newFilename.substring(lastDot) : "";
      let n = 2;
      while (existingMedia.has(`word/media/${stem}_corpo${n}${ext}`)) n++;
      newFilename = `${stem}_corpo${n}${ext}`;
    }

    // Copia o arquivo de mídia pro zip1
    zip1[`word/media/${newFilename}`] = zip2[srcPath];
    existingMedia.add(`word/media/${newFilename}`);

    // Novo rId
    const newRId = `rId${nextRId++}`;
    const newTarget = `media/${newFilename}`;
    newBaseRels = newBaseRels.replace(
      "</Relationships>",
      `<Relationship Id="${newRId}" Type="${IMAGE_TYPE}" Target="${newTarget}"/></Relationships>`
    );

    // Atualiza xml2 substituindo os rIds antigos pelos novos
    const escRId = rel.oldRId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    updatedXml2 = updatedXml2
      .replace(new RegExp(`r:embed="${escRId}"`, "g"), `r:embed="${newRId}"`)
      .replace(new RegExp(`r:link="${escRId}"`,  "g"), `r:link="${newRId}"`);
  }

  zip1[relsKey] = strToU8(newBaseRels);
  return updatedXml2;
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
    if (p.data && !isValidDateInput(p.data))
      return `Parcela "${p.tipo}": data inválida ("${p.data}"). Use DD/MM/AAAA ou AAAA-MM-DD.`;
  }

  // ─── Datas: rejeita inválidas pra evitar contrato com "31 de fevereiro" etc.
  if (dados.data_assinatura && !isValidDateInput(dados.data_assinatura))
    return `data_assinatura inválida ("${dados.data_assinatura}"). Use DD/MM/AAAA ou AAAA-MM-DD.`;
  if (dados.data_escritura && !isValidDateInput(dados.data_escritura))
    return `data_escritura inválida ("${dados.data_escritura}"). Use DD/MM/AAAA ou AAAA-MM-DD.`;

  // ─── CPF/CNPJ: bloqueia dígito verificador inválido a menos que o frontend
  // tenha pedido bypass explícito (modal "Gerar mesmo assim" pra teste/fictício).
  if (!dados.bypass_documento_invalido) {
    const docsInvalidos = getDocsInvalidos(dados);
    if (docsInvalidos.length > 0) {
      return `Documento(s) inválido(s): ${docsInvalidos.join("; ")}. Corrija ou confirme "Gerar mesmo assim" no frontend.`;
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
  "https://soter-contratos-ps58ghmbn-leovillacamellos-projects.vercel.app",
  "https://soter-contratos.vercel.app",
]);

serve(async (req) => {
  // CORS strict: sem fallback "*" quando Origin está ausente. Hoje, o único
  // caso legítimo sem Origin seria server-to-server, que não precisa de CORS
  // mesmo. Tirar o * fecha a porta pra atacante que faça request via curl/proxy
  // sem o header (importante mesmo com JWT obrigatório — defesa em profundidade).
  const origin = req.headers.get("origin") || "";
  const allowedOrigin = ORIGENS_PERMITIDAS.has(origin) ? origin : null;
  if (!allowedOrigin) {
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

    // Auditoria: se o frontend pediu bypass de documento inválido, registra
    // no log com user_email + lista de docs problemáticos.
    if (dados.bypass_documento_invalido) {
      const docsInvalidos = getDocsInvalidos(dados);
      if (docsInvalidos.length > 0) {
        console.warn(
          `[gerar-contrato] BYPASS doc inválido — user=${userEmail} (${userId}) sigla=${dados.sigla} docs=${JSON.stringify(docsInvalidos)}`,
        );
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ─── Validar sigla e buscar configuração de templates
    const { data: empRow, error: empError } = await supabase
      .from("empreendimentos")
      .select("sigla, template_contrato_destacada, template_corpo_destacada, template_contrato_cabeca_avista, template_contrato_faturada, template_corpo_faturada, template_contrato_semcomissao, template_corpo_semcomissao, template_contrato_semcomissao_avista, taxa_comissao")
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
    if (dados.sem_comissao) {
      comissao.tipo = "faturada";
      comissao.total_comissao = 0;
      comissao.parcela_desconto = null;
    }
    const PARCELAS_VALIDAS = new Set(["ato", "complemento_30", "complemento_60"]);
    if (dados.parcela_desconto_manual && !dados.sem_comissao) {
      if (!PARCELAS_VALIDAS.has(dados.parcela_desconto_manual))
        return new Response(JSON.stringify({ error: "parcela_desconto_manual inválida" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } });
      comissao.tipo = "destacada";
      comissao.parcela_desconto = dados.parcela_desconto_manual;
    }

    // ─── Detecta pagamento à vista (sinal == valor de venda)
    const isAvista = preco > 0 && sinal >= preco;

    // ─── Templates — usa colunas do banco, fallback para convenção de nome
    const tpls = getTemplates(dados.sigla || "", comissao.tipo, isAvista, !!dados.sem_comissao, empRow ?? undefined);

    // ─── Fração ideal e vagas — sempre do banco, nunca do payload
    let fracaoIdeal = "";
    let vagas       = "";

    if (dados.sigla && dados.unidade) {
      let query = supabase
        .from("unidades")
        .select("fracao_ideal, vaga")
        .eq("sigla", dados.sigla)
        .eq("unidade", dados.unidade);
      if (dados.bloco) query = query.eq("bloco", dados.bloco);
      const { data: u, error: uErr } = await query.single();
      if (uErr) console.error("unidades lookup error:", JSON.stringify(uErr));
      if (u) {
        fracaoIdeal = u.fracao_ideal || "";
        vagas       = String(u.vaga ?? "");
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
    const VIAS_EXT: Record<number, string> = { 2: "duas", 3: "três", 4: "quatro", 5: "cinco", 6: "seis" };
    const vias = dados.vias_fisicas || 2;
    const tipoAssStr = dados.tipo_ass === "digital"
      ? "meio digital"
      : `${vias} (${VIAS_EXT[vias] ?? "duas"}) vias físicas de igual forma e teor`;
    const slotName = (s?: Slot) => !s ? "" : s.tipo === "PJ" ? s.razao_social : (s as PFSlot).nome || "";
    const ass1 = dados.slots?.length ? slotName(dados.slots[0]) : (dados.compradores[0]?.nome || "");

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
      "«M__SINAL»":          formatarPercentual(percentual),
      "«PRECO»":             `R$${formatar(precoExibido)} (${extenso(precoExibido)})`,
      "«SINAL»":             `R$${formatar(sinalExibido)} (${extenso(sinalExibido)})`,
      "«UNIDADE»":           dados.unidade || "",
      "«VAGAS»":             vagas,
      "«VLR_COMISSAO»":      `R$${formatar(totalComissao)} (${extenso(totalComissao)})`,
      // TOTAL_COMISSAO: mantém ,00 no valor. Se o template tinha ",00" hardcoded depois,
      // a função substituirCorretores remove o run ",00" duplicado em seguida.
      "«TOTAL_COMISSAO»":    formatar(totalComissao),
      "«TOTAL_COMISSÃO»":    formatar(totalComissao),
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
    // Remove negrito do parágrafo "Niterói, [DATA]." antes de substituir
    xml2 = removeNegritoParagrafo(xml2, "«Data_Assinatura»");
    // Modo Adobe: insere as marcações (text tags) de assinatura na última página.
    // Ordem dos signers: compradores (1..B) → diretores (B+1, B+2) → testemunhas (B+3, B+4).
    const adobeOpts = (dados as unknown as {
      assinatura_adobe?: { testemunhas?: { nome?: string; cpf?: string; rg?: string }[] };
    }).assinatura_adobe;
    const modoAdobe = !!adobeOpts;
    const numCompradores = listarSignatarios(dados).length;

    xml2 = substituirAssinaturas(xml2, listarSignatarios(dados), modoAdobe);
    if (modoAdobe) {
      xml2 = marcarDiretores(xml2, numCompradores);
      xml2 = preencherEMarcarTestemunhas(xml2, adobeOpts!.testemunhas || [], numCompradores + 3);
    }
    xml2 = substituir(xml2, {
      "«Data_Assinatura»": dataExtenso(dados.data_assinatura || ""),
      "«TIPO_ASS»":              tipoAssStr,
      "«FORMA_DE_ASSINATURA»":   tipoAssStr,
      "«UNIDADE»":         dados.unidade || "",
    });

    // ─── Corretores
    if (dados.corretores?.length) {
      xml1 = substituirCorretores(xml1, dados.corretores);
      xml1 = fixCorretagemPluralMarkers(xml1, dados.corretores.length);
    }

    // ─── Strip Word MERGEFIELD field structures (keeps display text, removes field codes)
    xml1 = stripMergeFields(xml1);
    xml2 = stripMergeFields(xml2);

    // ─── Copia mídia do corpo (zip2) para zip1 e renumera rIds que conflitam.
    // Sem isso, imagens do corpo apareceriam quebradas ("Não é possível exibir esta imagem")
    // porque o zipBase usa zip1 como base — rIds reusados pelo corpo apontariam para alvos
    // errados (footer/hyperlink) na rels da cabeça.
    xml2 = mesclarMidiasCorpo(zip1, zip2, xml2);

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
    // Bucket "contratos" é criado pela migration migration_storage.sql — não tentar
    // criar a cada request (gera log spam e round-trip desperdiçada).
    let savedPath = "";
    try {
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
