#include "totvs.ch"

Static cStatico := "valor estatico"

/*/{Protheus.doc} zTstDbg1
Fonte de teste do E2E de depuracao do tds-mcp: locais, privadas, estatica,
array, JSON e chamada aninhada. Inofensivo; nao grava nada.
@type user function
@author tds-mcp
@since 02/10/2026
@param cArg, character, texto qualquer (padrao "sem argumento")
@return numeric, soma dos dobros de 1 a 3 (12)
/*/
User Function zTstDbg1(cArg)
    Local nI       := 0
    Local nTotal   := 0
    Local cNome    := "Teste debug"
    Local aItens   := {"um", "dois", {"tres", 3}}
    Local oJson    := JsonObject():New()
    Private cPriv  := "privada"
    Private nPriv  := 42
    Default cArg   := "sem argumento"

    oJson["cliente"] := "000001"
    oJson["valor"]   := 123.45

    For nI := 1 To 3
        nTotal += zTstSoma(nI)
    Next nI

    cNome := cNome + " " + cArg + " " + cStatico + " " + cValToChar(Len(aItens))
Return nTotal

/*/{Protheus.doc} zTstSoma
Dobra o valor e incrementa a privada nPriv do chamador.
@type static function
@author tds-mcp
@since 02/10/2026
@param nValor, numeric, valor a dobrar
@return numeric, nValor * 2
/*/
Static Function zTstSoma(nValor)
    Local nDobro := nValor * 2
    nPriv += 1
Return nDobro

/*/{Protheus.doc} zTstDbgE
Gera erro de execucao proposital (variavel inexistente) para o E2E.
@type user function
@author tds-mcp
@since 02/10/2026
@return numeric, nunca retorna: a linha do erro interrompe a execucao
/*/
User Function zTstDbgE()
    Local nA := 10
    nA := nA + nVarNaoExisteE2e
Return nA

/*/{Protheus.doc} zTstDbgT
Abre um dialogo de confirmacao e espera resposta, para o E2E ler a tela.
@type user function
@author tds-mcp
@since 05/10/2026
@return logical, resposta do dialogo
/*/
User Function zTstDbgT()
    Local lSim := MsgYesNo("Tela de teste do E2E: confirma?", "zTstDbgT")
Return lSim
