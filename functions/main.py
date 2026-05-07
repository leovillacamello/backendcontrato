import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from firebase_functions import https_fn
from firebase_admin import initialize_app, firestore, storage
from datetime import datetime, timezone
import uuid

from motor import gerar_contrato_bytes

initialize_app()

@https_fn.on_request()
def gerar_contrato(req: https_fn.Request) -> https_fn.Response:
    if req.method == "OPTIONS":
        return https_fn.Response("", status=204, headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST",
            "Access-Control-Allow-Headers": "Content-Type",
        })

    dados = req.get_json()
    if not dados:
        return https_fn.Response("Dados inválidos", status=400, headers={"Access-Control-Allow-Origin": "*"})

    try:
        sigla    = (dados.get("sigla") or "").strip()
        unidade  = (dados.get("unidade") or "").strip()
        bloco    = (dados.get("bloco") or "").strip()
        prefixo  = f"{sigla} {unidade}".strip() or "contrato"
        filename = f"{prefixo} - Contrato Promessa de Compra e Venda.docx"

        docx = gerar_contrato_bytes(dados)

        # Salvar no Storage
        contrato_id = str(uuid.uuid4())
        bucket = storage.bucket()
        blob = bucket.blob(f"contratos/{contrato_id}.docx")
        blob.upload_from_string(docx, content_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        blob.make_public()
        download_url = blob.public_url

        # Salvar no Firestore
        compradores = dados.get("compradores", [{}])
        cliente = compradores[0].get("nome", "") if compradores else ""

        db = firestore.client()
        db.collection("historico").document(contrato_id).set({
            "empreendimento": sigla,
            "bloco": bloco,
            "unidade": unidade,
            "cliente": cliente,
            "valor_venda": dados.get("preco_direto") or 0,
            "tipo_contrato": dados.get("tipo_comissao") or "",
            "data_geracao": datetime.now(timezone.utc).isoformat(),
            "download_url": download_url,
            "filename": filename,
        })

        return https_fn.Response(docx, status=200, headers={
            "Access-Control-Allow-Origin": "*",
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })

    except Exception as e:
        return https_fn.Response(str(e), status=500, headers={"Access-Control-Allow-Origin": "*"})