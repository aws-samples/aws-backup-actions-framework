# AWS Backup Actions Framework

AWS Backup Actions es un framework para automatizar acciones gatilladas por events de AWS Backup

Esta solución incluye implementaciones de muestra para exportar volumenes AWS EBS a archivos comprimidos para archivarlos a largo plazo en Amazon S3 y exportar backups de Amazon DynamoDB y snapshots de Amazon RDS con [motores y versiones][1] y [versiones de Aurora][2] que soportan exportar snapshots a S3 en el formato Parquet para archivos consultables a largo plazo. Puede implementar otros casos de uso como exportar dumps nativos de snapshots de RDS según el ejemplo de EBS.

NOTA: Esta aplicación creará roles y políticas de IAM.

## ¿Cómo funciona?
Cualquier snapshot creada en el AWS Backup Vault designado activará un proceso para restaurar el backup, copiar los datos a
S3 y eliminar el recurso restaurado. La solución elimina el backup solo en caso de éxito para que la retención de AWS Backup pueda seguir preservando los datos en caso de fallo.

La solución utiliza AWS Step Functions para orquestar los procesos. AWS Lambda y AWS Batch con instancias Amazon EC2 Spot realizan el
procesos de restauración y backup.

### EBS
1. Restaura la snapshot a un volumen GP2 en una AZ determinada. Espera a que esté disponible.
2. Inicia un Batch Job en la misma AZ.
3. El Batch Job conecta el volumen de EBS a la instancia del contenedor de una manera que permite que el contenedor que se ejecuta como root acceda y monte el dispositivo de bloque.
4. Los archivos se archivan y comprimen mediante tar y se transmiten a S3 por streaming.
5. Si por alguna razón el sistema de archivos en el volumen de EBS no se puede montar, el dispositivo de bloque se copia con dd, se comprime con gzip y se transmite a S3 por streaming.
6. El volumen restaurado se elimina después de éxito o cualquier error.

### DynamoDB y motores y versiones soportados de RDS 
1. Llama al API para exportar el snapshot a S3 en el formato comprimido Parquet.
2. Monitorea la tarea hasta éxito o fallo.

### Como implementar soporte para otros motores de RDS
1. Restaura la snapshot a una AZ dada en un tipo de instancia de bajo costo con volúmenes GP2 o Aurora con una contraseña root aleatoria.
2. Almacena la contraseña cifrada en SSM Parameter Store.
3. Inicia un Batch Job en la misma AZ.
4. El Batch Job se conecta a la base de datos y ejecuta el comando dump del motor, comprime con gzip y transmite a S3 por streaming.
5. La instancia restaurada se elimina después de éxito o cualquier error.

## Costos
Aparte del almacenamiento en S3 y VPC Interface Endpoints, esta solución solo genera costos mientras procesa una snapshot.

Suponiendo que la fuente de datos original era de 100GB, el costo por exportación excluyendo almacenamiento y VPC Interface Endpoints sigue:
EBS: ~$0.65
RDS: ~$1.05
DynamoDB: ~$10.05

Los siete VPC Interface Endpoints son el costo más alto de esta solución en unos $151 mensuales. El tráfico a internet es sólo para llamadas API a EC2, ECR, y Batch. El tráfico de S3 y DynamoDB utilizan los VPC Gateway Endpoints. Nada en la solución escucha el tráfico entrante. Podría usar un VPC NAT Gateway por unos $33 por mes, pero el tráfico de egreso no es controlado. A su propio riesgo, esta solución puede funcionar sin un NAT Gateway o VPC Interface Endpoints, pero las instancias EC2 administradas por AWS Batch requerirán acceso directo a Internet y direcciones IP públicas. El Security Group puede impedir el acceso entrante desde Internet, y no se abren puertos para el tráfico entrante.

## Instrucciones de despliegue
```
cp cdk.json.template cdk.json
``` 

Edite cdk.json para especificar su cuenta, región, BackupVault y etiquetas. La etiqueta de seguridad es opcional para
restringir los roles de IAM creados eliminar recursos que no fueron creados por esta aplicación.

```
npm install
cd functions/sanpshotMetadata
npm install
cd ../..
npm run build
```

Configure su entorno con AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY y posiblemente AWS_SESSION_TOKEN para poder
implementar en su cuenta.

```
cdk synth
cdk deploy
```

### S3 Server Access Logs (Opcional)
Puede habilitar S3 Server Access Logs por especificar un bucket y prefijo en `cdk.json`. El bucket para los access logs debe se configurado para [permitir acceso desde el Amazon S3 Log Delivery Group][3]

### S3 Lifecycle Rules (Opcional)
Para unos caso de uso como archivar a largo plazo, los objetos solo deberían ser eliminados con Lifecycle Rules. Considere restringir opseraciones de delete con MFA Delete en la pólitica del bucket.

Puede configurar las Lifecycle Rules en el `cdk.json` bajo la clave `lifecycleRules`. Por ejemplo:

```
"lifecycleRules: {
    "glacier": 10,
    "deepArchive": 101,
    "expiration": 2190
}
```

[1]: https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ExportSnapshot.html
[2]: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_ExportSnapshot.html
[3]: https://docs.aws.amazon.com/AmazonS3/latest/userguide/enable-server-access-logging.html#grant-log-delivery-permissions-general
