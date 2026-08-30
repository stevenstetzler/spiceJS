KPL/MK

   Minimal meta-kernel fixture: loads just the leapseconds kernel
   that sits alongside this file, using a PATH_SYMBOLS substitution
   (exercised so spiceJS's meta-kernel support has test coverage).

\begindata

   PATH_VALUES     = ( '.' )
   PATH_SYMBOLS    = ( 'KERNELS' )
   KERNELS_TO_LOAD = ( '$KERNELS/naif0012.tls' )

\begintext

End of file.
