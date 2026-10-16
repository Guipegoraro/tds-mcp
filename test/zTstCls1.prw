#include "totvs.ch"

/*/{Protheus.doc} zTstCls1
Classe do E2E de depuracao do tds-mcp: propriedades lidas dentro de metodo
(::prop e self:prop). Inofensiva; nao grava nada.
@type class
@author tds-mcp
@since 06/10/2026
/*/
Class zTstCls1
    Data nValor
    Data cNome
    Data aLista

    Method New() Constructor
    Method Somar(nQtd)
    Method Dobro()
EndClass

/*/{Protheus.doc} New
Cria o objeto com valores conhecidos.
@type method
@author tds-mcp
@since 06/10/2026
@return object, a instancia
/*/
Method New() Class zTstCls1
    ::nValor := 10
    ::cNome  := "objeto teste"
    ::aLista := {"a", "b"}
Return Self

/*/{Protheus.doc} Somar
Soma nQtd a nValor.
@type method
@author tds-mcp
@since 06/10/2026
@param nQtd, numeric, quantidade a somar
@return numeric, nValor depois da soma
/*/
Method Somar(nQtd) Class zTstCls1
    Local nAntes := ::nValor

    ::nValor := nAntes + nQtd
Return ::nValor

/*/{Protheus.doc} Dobro
Dobro de nValor, sem alterar o objeto.
@type method
@author tds-mcp
@since 06/10/2026
@return numeric, nValor * 2
/*/
Method Dobro() Class zTstCls1
Return ::nValor * 2

/*/{Protheus.doc} U_zTstCls1
Cria o objeto e chama Somar(5).
@type function
@author tds-mcp
@since 06/10/2026
@return numeric, 15
/*/
User Function zTstCls1()
    Local oObj := zTstCls1():New()
    Local nRes := oObj:Somar(5)
Return nRes
