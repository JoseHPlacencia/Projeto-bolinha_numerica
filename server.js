
const io = require("socket.io")(3000, {
    cors: { origin: "*", credentials: true }
});
const rooms = {};

// Função para gerar uma cor hexadecimal aleatória
const getRandomColor = () => {
    const letters = '0123456789ABCDEF';
    let color = '#';
    for (let i = 0; i < 6; i++) {
        color += letters[Math.floor(Math.random() * 16)];
    }
    return color;
};

io.on("connection", (socket) => {
    socket.on("join-room", (roomId) => {
        socket.join(roomId);
        socket.currentRoom = roomId;

        if (!rooms[roomId]) rooms[roomId] = {};

        // Atribui a cor aleatória aqui
        rooms[roomId][socket.id] = { 
            x: 150, 
            y: 75, 
            color: getRandomColor() 
        };

        io.to(roomId).emit("update-players", rooms[roomId]);
    });

    socket.on("move", (roomId, data) => {
        if (rooms[roomId] && rooms[roomId][socket.id]) {
            rooms[roomId][socket.id].x += data.x;
            rooms[roomId][socket.id].y += data.y;
            io.to(roomId).emit("update-players", rooms[roomId]);
        }
    });

    socket.on("disconnecting", () => {
        socket.rooms.forEach(roomId => {
            if (rooms[roomId] && rooms[roomId][socket.id]) {
                delete rooms[roomId][socket.id];
                
                // Se a sala ficar vazia, podes opcionalmente removê-la para poupar memória
                if (Object.keys(rooms[roomId]).length === 0) {
                    delete rooms[roomId];
                } else {
                    io.to(roomId).emit("update-players", rooms[roomId]);
                }
            }
        });
    });
});


