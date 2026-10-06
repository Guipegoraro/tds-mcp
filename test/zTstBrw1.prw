#include "totvs.ch"

/*/{Protheus.doc} zTstBrw1
Fonte de teste do tds-mcp para operar grade no modo navegador: dialogo com
FWBrowse sobre array, SetDoubleClick e um botao com a mesma acao. Cada
acionamento passa por zBrwAcao, que conta e mostra na tela de onde veio.
Inofensivo; nao grava nada.
@type user function
@author tds-mcp
@since 06/10/2026
@return numeric, quantidade de acionamentos ate o dialogo fechar
/*/
User Function zTstBrw1()
    Local oDlg
    Local oPanBrw
    Local oPanBot
    Local oBrowse
    Local oCol1
    Local oCol2
    Local aDados := {{"001", "PRIMEIRA LINHA"}, {"002", "SEGUNDA LINHA"}, {"003", "TERCEIRA LINHA"}}
    Private nTstBrwQtd := 0
    Private cTstBrwUlt := "nenhum"
    Private oTstBrwSay

    oDlg := MSDialog():New(0, 0, 400, 600, "zTstBrw1 duplo clique", , , .F., , , , , , .T.)

    oPanBot := TPanel():New(0, 0, "", oDlg, , , , , , 300, 40)
    oPanBot:Align := CONTROL_ALIGN_BOTTOM
    oPanBrw := TPanel():New(0, 0, "", oDlg, , , , , , 300, 150)
    oPanBrw:Align := CONTROL_ALIGN_ALLCLIENT

    oBrowse := FWBrowse():New()
    oBrowse:SetOwner(oPanBrw)
    oBrowse:SetDataArray()
    oBrowse:SetArray(aDados)
    oBrowse:DisableConfig()
    oBrowse:DisableReport()

    oCol1 := FWBrwColumn():New()
    oCol1:SetData({|| aDados[oBrowse:At(), 1]})
    oCol1:SetTitle("Codigo")
    oCol1:SetSize(6)
    oCol2 := FWBrwColumn():New()
    oCol2:SetData({|| aDados[oBrowse:At(), 2]})
    oCol2:SetTitle("Descricao")
    oCol2:SetSize(30)
    oBrowse:SetColumns({oCol1, oCol2})

    oBrowse:SetDoubleClick({|| zBrwAcao("duplo clique", aDados[oBrowse:At(), 1])})
    oBrowse:Activate()

    oTstBrwSay := TSay():New(4, 4, {|| "Acionamentos: " + cValToChar(nTstBrwQtd) + " ultimo: " + cTstBrwUlt}, oPanBot, , , , , , .T., , , 200, 12)
    TButton():New(20, 4, "Acao da linha", oPanBot, {|| zBrwAcao("botao", aDados[oBrowse:At(), 1])}, 60, 14, , , , .T.)
    TButton():New(20, 70, "Fechar", oPanBot, {|| oDlg:End()}, 50, 14, , , , .T.)

    oDlg:Activate(, , , .T.)
Return nTstBrwQtd

/*/{Protheus.doc} zBrwAcao
Conta o acionamento e mostra a origem e a linha na tela.
@type static function
@author tds-mcp
@since 06/10/2026
@param cOrigem, character, "duplo clique" ou "botao"
@param cCodigo, character, codigo da linha posicionada
@return logical, sempre .T.
/*/
Static Function zBrwAcao(cOrigem, cCodigo)
    nTstBrwQtd++
    cTstBrwUlt := cOrigem + " na linha " + cCodigo
    oTstBrwSay:Refresh()
Return .T.
