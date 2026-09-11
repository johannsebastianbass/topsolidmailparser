// Log simples com horário e escopo. Substitui os console.log soltos e as
// linhas de '-----------------------------' espalhadas pelo código.

const horario = () => new Date().toISOString();

export function log(mensagem, valor) {
    if (valor === undefined) {
        console.log(`[${horario()}] ${mensagem}`);
    } else {
        console.log(`[${horario()}] ${mensagem}`, valor);
    }
}

export function erro(mensagem, e) {
    // Erro de axios traz o corpo da resposta, que é onde o Bitrix explica a falha.
    const detalhe = e && e.response && e.response.data ? e.response.data : (e && e.message) || e;
    console.error(`[${horario()}] ERRO ${mensagem}:`, detalhe);
}

export function separador() {
    console.log('-----------------------------');
}
