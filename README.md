# Xitike Célia

Bot de WhatsApp para gestão, validação de valores dos xitiques de Cabelos e Iphone, com
confirmação automática de pagamentos M-Pesa/e-Mola e painel web.

## Comandos do bot (dentro do grupo de WhatsApp)

- `!novo Nome Valor DiasAteReceber` — cria um xitique novo (só a Célia)
- `!ordem 84XXXXXXX 3` — define a posição de um membro na fila de recebimento (só a Célia)
- `!fila` — mostra a ordem de quem recebe o pote
- `!recebeu 84XXXXXXX` — marca que alguém recebeu o pote e avança a rodada (só a Célia)
- `!cadastrar 84XXXXXXX Nome Completo` — regista um membro que ainda não escreveu no grupo (só a Célia)
- `!pagos` (seguido de uma linha `numero Nome valor` por membro) — importa em massa quem já pagou, pra grupos que já estavam a decorrer antes do bot (só a Célia)
- `!atribuir IDTransacao 84XXXXXXX` — liga manualmente um pagamento pendente a um membro (só a Célia)
- `!banir 84XXXXXXX` — remove um membro do grupo (só a Célia)
- `!pendentes` — lista pagamentos que ainda precisam de atribuição manual
- `!resumo` — mostra a situação de cada membro (em dia / dívida / crédito)
- `!ajuda` — mostra esta lista dentro do WhatsApp

Como funciona: 
Cliente: cola no grupo a SMS de confirmação de pagamento (M-Pesa ou e-Mola) —
**ou manda um print da confirmação**, o bot lê o texto de dentro da imagem
automaticamente (OCR). O bot regista automaticamente se o destino bater com
um número oficial configurado; caso contrário, avisa em vez de creditar sozinho.

O servidor **não** escolhe o grupo/membro sozinho a partir da SMS — quem diz
o grupo certo é sempre o cliente, ao postar a própria confirmação lá dentro
(uma pessoa pode estar em vários xitiques ao mesmo tempo, então adivinhar
pelo nome não seria seguro). A SMS real só serve como prova: o bot cruza pelo
**ID da transação**, que é o mesmo dos dois lados (quem manda e quem recebe
usam a mesma referência, confirmado com exemplos reais).

Como deve funcionar na prática:
- Cliente manda a confirmação no grupo → se a SMS real já tiver chegado com
  o mesmo ID, valida na hora. Se ainda não chegou, avisa "a aguardar SMS
  real" e fica guardado.
- A SMS real chega via Atalho → se já havia alguém à espera com esse ID,
  completa o pagamento nesse instante. Se não, fica guardada à espera de
  alguém postar.
- `!pendentes` (admin) mostra os dois tipos de pendência.

Sem o `WEBHOOK_TOKEN` configurado, o bot volta ao modo antigo (só checa se o
destino bate com os números oficiais).
