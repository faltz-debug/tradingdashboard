from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def make_table(rows, widths, header_color):
    table = Table(rows, colWidths=widths)
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), header_color),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#cbd5e1")),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("PADDING", (0, 0), (-1, -1), 5),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.whitesmoke, colors.HexColor("#f8fafc")]),
            ]
        )
    )
    return table


def build_pdf(pdf_path: Path):
    pdf_path.parent.mkdir(parents=True, exist_ok=True)

    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="BodyPT",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=10,
            leading=14,
            alignment=TA_LEFT,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="SmallPT",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=9,
            leading=12,
            alignment=TA_LEFT,
            spaceAfter=4,
        )
    )
    styles["Title"].fontName = "Helvetica-Bold"
    styles["Title"].fontSize = 18
    styles["Heading1"].fontName = "Helvetica-Bold"
    styles["Heading1"].fontSize = 13

    story = []
    story.append(Paragraph("Relatorio de Trading do Bot - Analise MT5 Confirmada", styles["Title"]))
    story.append(Spacer(1, 4 * mm))
    story.append(
        Paragraph(
            "Base analisada: 113 trades confirmados pelo MT5, exportacao de 06/05/2026.",
            styles["BodyPT"],
        )
    )
    story.append(
        Paragraph(
            "Objetivo: avaliar se o bot tem edge, onde esta a perder qualidade e quais filtros tendem a melhorar win rate, profit factor e estabilidade operacional.",
            styles["BodyPT"],
        )
    )

    story.append(Paragraph("1. Resumo Executivo", styles["Heading1"]))
    story.append(
        make_table(
            [
                ["Metrica", "Valor"],
                ["Trades confirmados MT5", "113"],
                ["Win rate atual", "38.1%"],
                ["Total em R", "+7.63R"],
                ["Profit factor", "1.11"],
                ["Drawdown maximo", "16.7R"],
                ["Maior sequencia de losses", "9"],
            ],
            [70 * mm, 50 * mm],
            colors.HexColor("#1f2937"),
        )
    )
    story.append(Spacer(1, 4 * mm))
    story.append(
        Paragraph(
            "Leitura profissional: o bot esta positivo, mas ainda com margem curta. Ha edge, porem ele esta a desperdiçar esse edge por operar tempo demais, contexto demais e alguns ativos/direcoes piores do que o resto.",
            styles["BodyPT"],
        )
    )

    story.append(Paragraph("2. Leitura por Sessao", styles["Heading1"]))
    story.append(
        make_table(
            [
                ["Sessao", "Trades", "Win Rate", "PF", "Total R", "Leitura"],
                ["Tokyo + Londres", "14", "50.0%", "1.95", "+6.90R", "Melhor bloco operacional"],
                ["Londres + NY + Overlap", "17", "47.1%", "1.54", "+5.00R", "Bom contexto"],
                ["Tokyo", "29", "44.8%", "1.38", "+6.32R", "Bom, mas com DD maior"],
                ["Londres", "22", "31.8%", "0.89", "-1.79R", "Fraco isoladamente"],
                ["NY", "22", "18.2%", "0.35", "-11.95R", "Muito fraco, cortar"],
                ["Sem sessao", "6", "16.7%", "0.39", "-3.06R", "Evitar"],
            ],
            [45 * mm, 18 * mm, 24 * mm, 18 * mm, 20 * mm, 55 * mm],
            colors.HexColor("#0f766e"),
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        Paragraph(
            "Conclusao de trader: NY puro e trades fora de sessao estao a puxar o sistema para baixo. O bot parece responder melhor quando ha transicao ou participacao de Londres no fluxo.",
            styles["BodyPT"],
        )
    )

    story.append(Paragraph("3. Leitura por Ativo e Direcao", styles["Heading1"]))
    story.append(
        make_table(
            [
                ["Recorte", "Trades", "WR", "PF", "Total R"],
                ["EURUSD geral", "23", "43.5%", "1.39", "+5.13R"],
                ["BTC geral", "47", "38.3%", "1.10", "+2.91R"],
                ["XAUUSD geral", "28", "35.7%", "1.11", "+2.04R"],
                ["USDJPY geral", "15", "33.3%", "0.78", "-2.45R"],
                ["BTC BUY", "37", "40.5%", "1.27", "+6.22R"],
                ["BTC SELL", "10", "30.0%", "0.54", "-3.31R"],
                ["EURUSD SELL", "12", "41.7%", "1.43", "+3.03R"],
                ["EURUSD BUY", "11", "45.5%", "1.34", "+2.10R"],
                ["XAUUSD BUY", "12", "41.7%", "1.42", "+2.99R"],
                ["XAUUSD SELL", "16", "31.2%", "0.91", "-0.95R"],
                ["USDJPY BUY", "11", "36.4%", "0.84", "-1.29R"],
                ["USDJPY SELL", "4", "25.0%", "0.64", "-1.16R"],
            ],
            [42 * mm, 18 * mm, 18 * mm, 16 * mm, 24 * mm],
            colors.HexColor("#7c3aed"),
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        Paragraph(
            "Leitura profissional: EURUSD e BTC BUY merecem prioridade. USDJPY, no estado atual, esta a destruir qualidade. BTC SELL tambem esta fraco. XAUUSD BUY esta melhor que XAUUSD SELL.",
            styles["BodyPT"],
        )
    )

    story.append(Paragraph("4. Estimativa de Aumento de Win Rate", styles["Heading1"]))
    story.append(
        Paragraph(
            "Com base apenas nesta amostra, sem prometer resultado futuro, a expectativa mais realista e esta:",
            styles["BodyPT"],
        )
    )
    story.append(
        make_table(
            [
                ["Cenario", "Win rate estimado", "Observacao"],
                ["Estado atual", "38.1%", "Bot rodando amplo"],
                ["Cortar NY puro e Sem sessao", "41.5%", "Ganho conservador de 3-4 pontos"],
                ["Operar apenas blocos com Londres no contexto", "44.6%", "Ganho realista de 6-7 pontos"],
                ["Londres no contexto + scores 7 e 8", "46.2%", "Melhor filtro simples desta amostra"],
                ["BTC BUY + EURUSD qualquer lado + XAU BUY, em sessoes boas", "41.7% com PF 1.33", "Melhora mais qualitativa do que numerica"],
            ],
            [58 * mm, 35 * mm, 72 * mm],
            colors.HexColor("#92400e"),
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        Paragraph(
            "Conclusao: eu nao projetaria 55% ou 60% de win rate com seriedade ainda. O ganho plausivel hoje parece estar na faixa de 3 a 8 pontos percentuais, dependendo do rigor do filtro.",
            styles["BodyPT"],
        )
    )

    story.append(Paragraph("5. Recomendacao Pratica de Trader", styles["Heading1"]))
    recommendations = [
        "Desligar NY puro.",
        "Desligar trades Sem sessao.",
        "Pausar USDJPY por enquanto.",
        "Desligar BTC SELL.",
        "Favorecer BTC BUY.",
        "Manter EURUSD BUY e EURUSD SELL sob observacao, pois ambos estao aceitaveis.",
        "Favorecer XAUUSD BUY e reduzir peso de XAUUSD SELL.",
        "Recalibrar o score: score 7 e 8 estao melhores que 9 e 10 nesta amostra.",
        "Rodar mais 2 a 4 semanas antes de qualquer conclusao comercial mais dura.",
    ]
    for item in recommendations:
        story.append(Paragraph(f"• {item}", styles["BodyPT"]))

    story.append(Paragraph("6. Horarios das Sessoes em Portugal", styles["Heading1"]))
    story.append(
        Paragraph(
            "Como o relatorio foi pedido em maio, considero horario de Portugal continental em WEST (UTC+1).",
            styles["BodyPT"],
        )
    )
    story.append(
        make_table(
            [
                ["Sessao", "Horario Portugal"],
                ["Tokyo", "01:00 - 10:00"],
                ["Londres", "09:00 - 18:00"],
                ["Nova Iorque", "14:00 - 23:00"],
                ["Overlap Londres + NY", "14:00 - 18:00"],
                ["Transicao Tokyo + Londres", "09:00 - 10:00"],
            ],
            [65 * mm, 50 * mm],
            colors.HexColor("#111827"),
        )
    )
    story.append(Spacer(1, 3 * mm))
    story.append(
        Paragraph(
            "Nota: no inverno estes horarios andam, em regra, uma hora para tras em relacao ao verao.",
            styles["SmallPT"],
        )
    )

    story.append(Paragraph("7. Conclusao Final", styles["Heading1"]))
    story.append(
        Paragraph(
            "Como trader, eu nao mudaria o bot inteiro. Eu faria uma limpeza de contexto. O sistema ja mostrou que consegue gerar edge, mas o edge esta a ser diluido por operar sessoes fracas, ativos mais ruidosos e direcoes piores. A melhor adaptacao agora nao e inventar mais complexidade; e operar menos, mas melhor.",
            styles["BodyPT"],
        )
    )

    doc = SimpleDocTemplate(
        str(pdf_path),
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
    )
    doc.build(story)


if __name__ == "__main__":
    output = Path(r"C:\Users\cinti\Desktop\claude\dashboard com mt5\outputs\relatorio_bot_trading_2026-05-06.pdf")
    build_pdf(output)
    print(output)
