// socket.io-client v2 ships no type declarations. We only use the default
// io() factory and .on()/.close(), so an ambient `any` module is sufficient.
declare module "socket.io-client";
