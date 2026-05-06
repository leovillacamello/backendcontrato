import io
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from motor import gerar_contrato_bytes

app = FastAPI(title="Soter Motor API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ───────── MODELOS ───────────────────────────────────────────────────────────

class Comprador(BaseModel):
    nome: str
    cpf: str
    sexo: str = "M"
    nacionalidade: str = "brasileira"
    profissao: str = ""
    estado_civil: str = "solteiro"
    rg: str = ""
    orgao_emissor: str = ""
    data_emissao: str = ""

class Parcela(BaseModel):
    tipo: str
    qtd: int = 1
    valor: float
    data: str = ""
    reajustavel: bool = True

class Corretor(BaseModel):
    nome: str
    creci: str = ""
    cpf_cnpj: str = ""
    valor: float = 0

class Imobiliaria(BaseModel):
    empresa: str
    cnpj: str = ""
    percentual: float = 0

class ContratoRequest(BaseModel):
    compradores: List[Comprador]
    relacao: str = "solteiro / independentes"
    regime_bens: Optional[str] = ""
    data_escritura: Optional[str] = ""
    endereco: str = ""
    telefone: str = ""
    email: str = ""
    sigla: str = ""
    unidade: str = ""
    fracao_ideal: Optional[str] = ""
    vagas: Optional[str] = ""
    # Modo estruturado (frontend React / Streamlit struct)
    parcelas_diretas: Optional[List[Parcela]] = None
    preco_direto: Optional[float] = None
    # Modo texto livre (Streamlit legado)
    fluxo: Optional[str] = ""
    valor_venda_manual: Optional[float] = 0
    # Assinatura
    data_assinatura: str = ""
    tipo_ass: str = "digital"
    # Comissão
    corretores: Optional[List[Corretor]] = None
    imobiliarias: Optional[List[Imobiliaria]] = None
    parcela_desconto_manual: Optional[str] = None

# ───────── ROTAS ─────────────────────────────────────────────────────────────

@app.get("/")
def health():
    return {"status": "ok", "service": "Soter Motor API"}

@app.post("/api/contratos/gerar")
def gerar(req: ContratoRequest):
    try:
        dados = req.model_dump()
        docx  = gerar_contrato_bytes(dados)
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=f"Template não encontrado: {e}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    sigla    = (req.sigla or "").strip()
    unidade  = (req.unidade or "").strip()
    prefixo  = f"{sigla} {unidade}".strip() or "contrato"
    filename = f"{prefixo} - Contrato Promessa de Compra e Venda.docx"

    return StreamingResponse(
        io.BytesIO(docx),
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
