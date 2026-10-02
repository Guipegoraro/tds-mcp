#include "protheus.ch"

/*/{Protheus.doc} zTstDbg1
Fonte de teste do E2E de depuracao do tds-mcp: locais, privadas, publica,
estatica, array, JSON e chamada aninhada. Inofensivo; nao grava nada.
/*/
Static cStatico := "valor estatico"

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

Static Function zTstSoma(nValor)
    Local nDobro := nValor * 2
    nPriv += 1
Return nDobro

/*/{Protheus.doc} zTstDbgE
Gera erro de execucao proposital (variavel inexistente) para o E2E.
/*/
User Function zTstDbgE()
    Local nA := 10
    nA := nA + nVarNaoExisteE2e
Return nA
