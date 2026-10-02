#include "totvs.ch"

//-------------------------------------------------------------------
/*/{Protheus.doc} zTstMcp1
Fonte de teste do tds-mcp (compilacao + geracao de patch via MCP).
Pode ser removido do RPO com seguranca.

@type user function
@author tds-mcp
@since 19/07/2026
@return character, a mensagem "tds-mcp ok"
/*/
//-------------------------------------------------------------------
User Function zTstMcp1()
    Local cMsg := "tds-mcp ok"
    ConOut("[ZTSTMCP1] " + cMsg)
Return cMsg
