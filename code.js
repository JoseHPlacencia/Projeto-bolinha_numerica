
function gerarNumeroAleatorioPorConjunto() {
    const conjuntos = ['Natural', 'Inteiro', 'Racional', 'Irracional'];
    const conjuntoEscolhido = conjuntos[Math.floor(Math.random() * conjuntos.length)];
    
    let numero;
    let sinal = Math.random() < 0.5 ? -1 : 1;

    switch (conjuntoEscolhido) {
        case 'Natural':
            numero = Math.floor(Math.random() * 100);
            break;

        case 'Inteiro':
            numero = Math.floor(Math.random() * 100) * sinal;
            break;

        case 'Racional':
            let parteInteiraQ = Math.floor(Math.random() * 100);
            let parteDecimalQ = Math.floor(Math.random() * 100) / 100;
            numero = parseFloat((parteInteiraQ + parteDecimalQ).toFixed(2)) * sinal;
            break;

        case 'Irracional':
            let parteInteiraI = Math.floor(Math.random() * 100);
            let parteDecimalI = Math.random();
            numero = (parteInteiraI + parteDecimalI) * sinal;
            break;
    }

    return {
        conjunto: conjuntoEscolhido,
        valor: numero
    };
}

for (let i = 0; i < 5; i++) {
    const resultado = gerarNumeroAleatorioPorConjunto();
    console.log(`Conjunto: ${resultado.conjunto.padEnd(10)} -> Número: ${resultado.valor}`);
}